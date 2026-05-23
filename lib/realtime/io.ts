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

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './events';

/**
 * Default workspace identifier used when `process.env.WORKSPACE_ID` is unset.
 * Mirrors the single-workspace MVP assumption (requirements.md §1.7).
 */
const DEFAULT_WORKSPACE_ID = 'ws_default';

/**
 * Resolve the active workspace id from the environment, falling back to
 * {@link DEFAULT_WORKSPACE_ID}. Read lazily (per call) so test setups can
 * mutate `process.env.WORKSPACE_ID` between server constructions.
 */
function resolveWorkspaceId(): string {
  const fromEnv = process.env.WORKSPACE_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORKSPACE_ID;
}

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
 * Singleton instance set by {@link createIOServer}. Service-layer modules
 * read it via {@link getIO} to broadcast events after a successful DB write.
 */
let ioInstance: AppIOServer | null = null;

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
      const token = await getToken({ req: req as never, secret });
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
    socket.on('subscribe:channel', (channelId: string) => {
      if (typeof channelId !== 'string' || channelId.length === 0) {
        return;
      }
      void socket.join(`channel:${channelId}`);
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

  ioInstance = io;
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
  return ioInstance;
}
