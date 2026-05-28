/**
 * Socket.io server factory and singleton accessor.
 *
 * This module wires a `socket.io` {@link Server} onto an existing Node.js
 * {@link HTTPServer} so that Next.js HTTP traffic and realtime traffic share
 * the same port (see design.md → "进程拓扑（单进程 server.ts）"). It exposes:
 *
 *   - {@link createIOServer}: build and configure the typed Socket.io server.
 *   - {@link getIO}: singleton accessor used by the service layer to broadcast
 *     events (`message:new`, `task:updated`, `ai:thinking`, `approval:created`)
 *     after a successful persistence step.
 *
 * Connection lifecycle:
 *   1. The handshake auth middleware reads the request cookie, asks
 *      `next-auth/jwt`'s {@link getToken} to decode the NextAuth session
 *      JWT, and rejects unauthenticated handshakes with
 *      `next(new Error('unauthenticated'))`. Successful handshakes have
 *      `socket.data.userId` populated (sourced from `token.uid`, falling
 *      back to `token.sub`).
 *   2. On `connection`, the socket auto-joins `workspace:{WORKSPACE_ID}`,
 *      where `WORKSPACE_ID` comes from `process.env.WORKSPACE_ID` and
 *      falls back to `'ws_default'` (matches the seeded single workspace).
 *      As a defense-in-depth check, a connection that somehow lacks
 *      `socket.data.userId` is disconnected immediately and not joined to
 *      any room.
 *   3. Clients opt in to per-channel updates by emitting
 *      `subscribe:channel` with a `channelId`; the socket then joins
 *      `channel:{channelId}`.
 *
 * Reference: design.md → "Realtime（Socket.io + NextAuth 会话校验）".
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 */

import type { IncomingMessage, Server as HTTPServer } from 'node:http';
import { decode, getToken } from 'next-auth/jwt';
import { Server as SocketIOServer } from 'socket.io';

import { parseCookieHeader, readChunkedCookie } from '@/lib/cookie-parser';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { resolveWorkspaceId } from '@/lib/workspace';

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './events';

/**
 * Resolve the NextAuth JWT secret from the validated environment. The
 * env module enforces a 32+ char minimum at startup, so by the time we
 * land here `env.NEXTAUTH_SECRET` is guaranteed to be set; reading
 * `process.env` directly here would defeat that guarantee.
 */
function resolveNextAuthSecret(): string {
  return env.NEXTAUTH_SECRET;
}

/**
 * Pull the authenticated user id out of a decoded NextAuth JWT.
 *
 * `token.uid` is set by our `jwt` callback in `lib/auth/options.ts`;
 * `token.sub` is the standard JWT subject claim that NextAuth populates
 * with the same id. Either is sufficient to identify the user. Returns
 * `null` when neither is a non-empty string — that includes the case of
 * `null` / `undefined` tokens from a failed decode.
 */
function extractUserId(
  token: { uid?: unknown; sub?: unknown } | null | undefined,
): string | null {
  if (!token) return null;
  if (typeof token.uid === 'string' && token.uid.length > 0) return token.uid;
  if (typeof token.sub === 'string' && token.sub.length > 0) return token.sub;
  return null;
}

function getCookieHeader(req: IncomingMessage): string {
  const header = req.headers.cookie;
  if (Array.isArray(header)) return header.join('; ');
  return header ?? '';
}

/**
 * Decode the NextAuth JWT from the raw Socket.io handshake request.
 *
 * NextAuth chooses between `next-auth.session-token` and
 * `__Secure-next-auth.session-token` based on its secure-cookie
 * heuristic. Behind Railway's HTTPS proxy the HTTP route layer can be
 * authenticated while this out-of-band Socket.io request is decoded with
 * the opposite heuristic, producing `connect_error: unauthenticated`.
 * Trying both explicit modes keeps local HTTP and proxied HTTPS
 * deployments compatible without exposing the raw JWT to the browser.
 */
async function getHandshakeToken(
  req: IncomingMessage,
  secret: string,
): Promise<Awaited<ReturnType<typeof getToken>>> {
  // Keep the framework path first for tests or adapters that attach a
  // parsed cookie bag to the request object.
  const defaultToken = await getToken({ req: req as never, secret });
  if (defaultToken) return defaultToken;

  const secureToken = await getToken({
    req: req as never,
    secret,
    secureCookie: true,
  });
  if (secureToken) return secureToken;

  const insecureToken = await getToken({
    req: req as never,
    secret,
    secureCookie: false,
  });
  if (insecureToken) return insecureToken;

  // Socket.io exposes a plain Node IncomingMessage. In NextAuth 4.24,
  // getToken() does not parse req.headers.cookie for that shape, so we
  // decode the standard JWT session cookie names directly.
  const cookies = parseCookieHeader(getCookieHeader(req));
  for (const cookieName of [
    '__Secure-next-auth.session-token',
    'next-auth.session-token',
  ]) {
    const rawToken = readChunkedCookie(cookies, cookieName);
    if (!rawToken) continue;
    try {
      const decoded = await decode({ token: rawToken, secret });
      if (decoded) return decoded;
    } catch {
      // Try the next supported cookie name.
    }
  }

  return null;
}

/**
 * Typed Socket.io server alias. Generics are sourced from
 * {@link ./events} so the emit / on surface stays in sync with the four
 * realtime events documented in design.md, and `socket.data.userId` is
 * strongly typed via {@link SocketData}.
 */
export type AppIOServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Process-wide Socket.io singleton. We store it on `globalThis`, not only
 * in this module's local scope, because Next's App Router can load route
 * handlers from a bundled module graph while `server.ts` loads this source
 * module directly via tsx. Both graphs share the same Node process global,
 * so this keeps broadcasts working from API routes on Railway.
 */
const IO_GLOBAL_KEY = '__aiNativeTeamWorkspaceIO';

type GlobalWithIO = typeof globalThis & {
  [IO_GLOBAL_KEY]?: AppIOServer | null;
};

function setGlobalIO(io: AppIOServer): void {
  (globalThis as GlobalWithIO)[IO_GLOBAL_KEY] = io;
}

function getGlobalIO(): AppIOServer | null {
  return (globalThis as GlobalWithIO)[IO_GLOBAL_KEY] ?? null;
}

/**
 * Build a Socket.io server bound to `httpServer`, install the NextAuth
 * session middleware, and register the default connection handler.
 *
 * The returned instance is also memoized as the module-level singleton so
 * that {@link getIO} can resolve it from anywhere in the process.
 *
 * @param httpServer - The same {@link HTTPServer} used by the Next.js
 *   request handler. Sharing it keeps HTTP and Socket.io on a single port.
 * @returns The configured, typed Socket.io server.
 */
export function createIOServer(httpServer: HTTPServer): AppIOServer {
  const io: AppIOServer = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer);

  /**
   * Handshake authentication: validate the NextAuth session on **every**
   * connection — including reconnects after a transient network drop —
   * so an expired session can never piggy-back on an old socket.
   *
   * Two complementary token sources are checked, in order:
   *
   *   1. **Explicit `auth.sessionToken`** — `lib/realtime/client.ts` reads
   *      the current session token via `next-auth/react`'s `getSession()`
   *      and forwards it on every (re)connect through the
   *      `auth: async (cb) => cb({ sessionToken })` callback. This is
   *      the primary path because socket.io's reconnect logic re-runs
   *      the `auth` callback fresh each time, so a stale session never
   *      survives a reconnect window.
   *
   *      The token is decoded with `next-auth/jwt`'s {@link decode}; an
   *      expired, malformed, or missing token is rejected with
   *      `next(new Error('SESSION_EXPIRED'))`. The client listens for
   *      this error code and triggers `signOut({ redirect: true })`,
   *      bouncing the user to `/login` instead of looping into endless
   *      reconnect attempts.
   *
   *   2. **Cookie fallback** — when the client did not (or could not)
   *      forward a token, we fall back to `getToken({ req })`, which
   *      reads the standard `next-auth.session-token` cookie attached
   *      to the handshake. Same accept / reject contract as above, but
   *      the rejection error is `'unauthenticated'` so the browser does
   *      not assume the session simply expired.
   *
   * Successful validation populates `socket.data.userId` and calls
   * `next()`; any exception (e.g. missing `NEXTAUTH_SECRET`) is
   * forwarded to `next(err)` so the Engine.IO transport surfaces a
   * clean connection error instead of crashing the process.
   *
   * Validates: Requirements 8.2 / 8.3 (handshake session check),
   *            P1 task #1 (session re-validation on reconnect).
   */
  io.use(async (socket, next) => {
    try {
      const secret = resolveNextAuthSecret();

      // ── Path 1: explicit sessionToken from the auth callback ─────────
      const auth = socket.handshake.auth as
        | { sessionToken?: unknown }
        | undefined;
      const rawSessionToken =
        auth && typeof auth.sessionToken === 'string'
          ? auth.sessionToken.trim()
          : '';

      if (rawSessionToken.length > 0) {
        let decoded: Awaited<ReturnType<typeof decode>> = null;
        try {
          decoded = await decode({ token: rawSessionToken, secret });
        } catch {
          // Treat any decode failure as an expired / tampered session so
          // the client can react with a hard sign-out instead of looping.
          return next(new Error('SESSION_EXPIRED'));
        }
        const userId = extractUserId(decoded);
        if (!userId) {
          return next(new Error('SESSION_EXPIRED'));
        }
        socket.data.userId = userId;
        return next();
      }

      // ── Path 2: cookie fallback (no explicit token forwarded) ────────
      const req = socket.request as IncomingMessage;
      const token = await getHandshakeToken(req, secret);
      const userId = extractUserId(token);
      if (!userId) {
        return next(new Error('unauthenticated'));
      }
      socket.data.userId = userId;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket) => {
    // Defense in depth: if the auth middleware was somehow bypassed and
    // no userId was attached, drop the connection before joining any
    // room. The handshake middleware should already have rejected the
    // socket, but this guard keeps the invariant explicit at the
    // connection boundary.
    if (!socket.data.userId) {
      socket.disconnect(true);
      return;
    }

    // Every connected client sees workspace-scoped events
    // (`task:updated`, `ai:thinking`, `approval:created`).
    const workspaceRoom = `workspace:${resolveWorkspaceId()}`;
    void socket.join(workspaceRoom);

    // Per-channel `message:new` events require an explicit subscription so
    // a client only receives traffic for channels it is actively viewing.
    // Validate the channel exists in the database before joining the room
    // — prevents clients from subscribing to non-existent channel ids.
    socket.on('subscribe:channel', async (channelId: string) => {
      if (typeof channelId !== 'string' || channelId.length === 0) {
        return;
      }
      try {
        const channel = await prisma.channel.findUnique({
          where: { id: channelId },
          select: { id: true },
        });
        if (!channel) return;
        void socket.join(`channel:${channelId}`);
      } catch {
        // Swallow transient DB errors — the client can retry.
      }
    });

    // Mirror unsubscribe so long-lived sessions release rooms when the
    // user navigates away from a channel. Without this, every channel
    // a socket has ever subscribed to remains in its room set until the
    // socket disconnects, growing the per-socket bookkeeping unbounded
    // on heavy users (audit nit L2). No DB lookup is needed — leaving a
    // room you are not in is a no-op in Socket.io.
    socket.on('unsubscribe:channel', (channelId: string) => {
      if (typeof channelId !== 'string' || channelId.length === 0) {
        return;
      }
      void socket.leave(`channel:${channelId}`);
    });

    // Structured disconnect log so operators can correlate transient
    // drops with reconnect storms or session-expiry sign-outs.
    socket.on('disconnect', (reason) => {
      logger.info(
        {
          event: 'socket_disconnect',
          userId: socket.data.userId,
          reason,
        },
        'Socket disconnected',
      );
    });
  });

  setGlobalIO(io);
  return io;
}

/**
 * Return the singleton Socket.io server created by the latest call to
 * {@link createIOServer}, or `null` if it has not been constructed yet.
 *
 * Service-layer modules call this after a successful persistence step to
 * broadcast realtime events. They MUST treat a `null` return as a no-op:
 * during early boot (before `server.ts` wires the IO server) or in unit
 * tests that exercise services without a live socket server, the
 * persistence path is unaffected and no event is emitted.
 *
 * @returns The active {@link AppIOServer} instance, or `null` when none has
 *   been created in the current process.
 */
export function getIO(): AppIOServer | null {
  return getGlobalIO();
}
