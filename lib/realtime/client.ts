'use client';

/**
 * Browser-side Socket.io provider.
 *
 * This module owns the singleton {@link Socket} that React components use
 * to receive realtime events from the server (`message:new`, `task:updated`,
 * `ai:thinking`, `approval:created`) and to opt in to per-channel rooms via
 * the `subscribe:channel` event handled by `lib/realtime/io.ts`.
 *
 * Reconnection is enabled by default (Requirements 8.7): when the underlying
 * transport drops, the client retries indefinitely with a 500ms base delay
 * and full jitter handled by `socket.io-client`.
 *
 * Session re-validation (P1 task #1):
 *   - On every (re)connect, socket.io-client invokes the `auth` callback
 *     fresh. We use it to fetch the current NextAuth session token via
 *     `next-auth/react`'s `getSession()` and forward it as
 *     `auth.sessionToken`. The server-side middleware in `lib/realtime/io.ts`
 *     verifies that token before accepting the handshake, so an expired
 *     session can never piggy-back on a reconnect.
 *   - When the server rejects with `Error('SESSION_EXPIRED')`, we trigger
 *     a hard sign-out (`signOut({ redirect: true })`) instead of looping
 *     into reconnect attempts; the user is bounced to `/login`.
 *
 * Usage:
 *   - {@link getClientSocket}: lazy singleton accessor — first call
 *     constructs the socket with the configured URL and reconnection
 *     options; subsequent calls return the same instance.
 *   - {@link subscribeToChannel}: emit `subscribe:channel` with the given
 *     `channelId` so the server joins this socket to `channel:{channelId}`.
 *
 * This module is marked `'use client'` and must only run in the browser.
 * Importing it from a Server Component or other server-side code is a
 * mistake — the singleton would attempt to open a websocket from Node.
 *
 * Reference: design.md → "Realtime（Socket.io + NextAuth 会话校验）".
 *
 * Validates: Requirements 8.7, 8.2 / 8.3 (reconnect re-auth).
 */

import { getSession, signOut } from 'next-auth/react';
import { io, type Socket } from 'socket.io-client';

import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from './events';

/**
 * Typed alias for the browser-side socket. The generics mirror those used
 * by the server in `lib/realtime/io.ts`, with the listen / emit roles
 * swapped: clients listen for {@link ServerToClientEvents} and emit
 * {@link ClientToServerEvents}.
 */
export type AppClientSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

/**
 * Resolve the Socket.io endpoint URL from the build-time public env var
 * `NEXT_PUBLIC_SOCKET_URL`. Read directly from `process.env` here (not
 * via `@/lib/env`) because that module performs server-side validation
 * with `process.exit(1)` and would crash a browser bundle. When the var
 * is unset (or empty), we return `undefined` so that {@link io} falls
 * back to the current page origin — matching the "single port for HTTP
 * + Socket.io" topology described in design.md.
 */
function resolveSocketUrl(): string | undefined {
  const fromEnv = process.env.NEXT_PUBLIC_SOCKET_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

const VALID_TRANSPORTS = ['websocket', 'polling'] as const;
type SocketTransport = (typeof VALID_TRANSPORTS)[number];

/**
 * Resolve the Socket.io transport list from
 * `NEXT_PUBLIC_SOCKET_TRANSPORTS` (comma-separated). Defaults to
 * `['websocket', 'polling']` so healthy networks use WS automatically
 * and broken WS fabrics fall back to polling without a redeploy.
 *
 * Unknown / empty entries are dropped silently. If the env var resolves
 * to no valid transport, we fall back to the default rather than crash
 * the singleton — better to degrade than to break realtime entirely.
 */
function resolveTransports(): readonly SocketTransport[] {
  const raw = process.env.NEXT_PUBLIC_SOCKET_TRANSPORTS;
  if (!raw || raw.trim().length === 0) {
    return ['websocket', 'polling'];
  }
  const parsed = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is SocketTransport =>
      (VALID_TRANSPORTS as readonly string[]).includes(t),
    );
  return parsed.length > 0 ? parsed : ['websocket', 'polling'];
}

/**
 * Module-level singleton. Lazily constructed on the first call to
 * {@link getClientSocket}. Held as `null` until then so that bundlers do
 * not open a connection at import time.
 */
let socketInstance: AppClientSocket | null = null;

/**
 * Server-issued error message that means "your session is no longer
 * valid; do not reconnect, sign out instead". Mirrors the value used in
 * `lib/realtime/io.ts` so client and server stay in lock-step.
 */
const SESSION_EXPIRED_ERROR = 'SESSION_EXPIRED';

/**
 * Auth callback used by socket.io-client. Re-runs on every (re)connect,
 * which is exactly what we want: a stale session is discarded as soon
 * as `getSession()` reflects the new state.
 *
 * `getSession()` may return either `{ token }` (when the JWT strategy
 * exposes the raw token) or no token at all. We tolerate both: when no
 * token is available we forward an empty string so the server falls
 * back to the cookie-based path in its handshake middleware.
 */
type SessionLike = Record<string, unknown> | null;

async function resolveSessionToken(): Promise<string> {
  let session: SessionLike = null;
  try {
    session = (await getSession()) as SessionLike;
  } catch {
    return '';
  }
  if (session !== null && typeof session === 'object') {
    const candidate = (session as { token?: unknown }).token;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

/**
 * Tag set when we detect `SESSION_EXPIRED` so the listener does not
 * fire `signOut` repeatedly during the (now-doomed) reconnect loop.
 */
let sessionExpiredHandled = false;

/**
 * Return the singleton browser-side Socket.io client, constructing it on
 * the first call. The socket is configured with infinite reconnection
 * attempts and a 500ms base delay so transient network blips do not
 * require a manual page refresh (Requirements 8.7).
 *
 * The configured options are:
 *   - `reconnection: true` — explicit even though it is the library
 *     default, so the contract stays visible at the call site.
 *   - `reconnectionAttempts: Number.POSITIVE_INFINITY` — keep retrying as
 *     long as the page is open; the underlying jitter / backoff is handled
 *     by `socket.io-client`.
 *   - `reconnectionDelay: 500` — start with a 500ms delay before the
 *     first reconnect attempt.
 *   - `autoConnect: true` — open the transport immediately so callers do
 *     not have to invoke `socket.connect()` themselves.
 *   - `auth: async (cb) => cb({ sessionToken })` — re-runs on every
 *     (re)connect so the server receives the *current* NextAuth JWT
 *     instead of one captured at first-load time.
 *
 * Subsequent calls return the same instance regardless of arguments. This
 * keeps a single shared transport across components and avoids redundant
 * handshakes / room joins.
 *
 * @returns The active {@link AppClientSocket} singleton.
 */
export function getClientSocket(): AppClientSocket {
  if (socketInstance) {
    return socketInstance;
  }

  const url = resolveSocketUrl();
  const options = {
    reconnection: true,
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    reconnectionDelay: 500,
    autoConnect: true,
    // Send cookies on every polling request. socket.io-client does
    // NOT include credentials by default; without this, the
    // long-polling handshake reaches our server stripped of the
    // NextAuth session cookie and the auth middleware rejects with
    // `connect_error { message: 'unauthenticated' }`. Setting this
    // flips XHR's `withCredentials` flag so the browser attaches the
    // same-origin session cookie that the App Router uses for HTTP
    // routes.
    withCredentials: true,
    // Transport selection. Default order is `['websocket', 'polling']`
    // so a healthy WebSocket connection is used when available (lower
    // latency, fewer server connections) and the client falls back to
    // long-polling when WS handshake or upgrade fails.
    //
    // Some edge proxies (notably some Railway / Cloudflare deployments)
    // strip the `Upgrade` header, breaking WS even when polling works.
    // For those environments operators can pin transports via the
    // `NEXT_PUBLIC_SOCKET_TRANSPORTS` env var, e.g. set it to `polling`
    // to recreate the previous polling-only behaviour without a
    // redeploy (audit finding M2).
    transports: [...resolveTransports()],
    auth: (cb: (payload: { sessionToken: string }) => void) => {
      // The callback must remain synchronous from socket.io's perspective,
      // but we can still await `getSession()` and invoke `cb` once we
      // have the token. socket.io-client awaits the cb internally and
      // re-invokes this for every reconnect (P1 task #1).
      void resolveSessionToken().then((sessionToken) => {
        cb({ sessionToken });
      });
    },
  };

  // `socket.io-client` accepts either `(url, opts)` or `(opts)`. We pass
  // the URL only when we have one so that omitting `NEXT_PUBLIC_SOCKET_URL`
  // lets the client default to the current origin.
  socketInstance = (
    url ? io(url, options) : io(options)
  ) as AppClientSocket;

  // Hard sign-out when the server reports SESSION_EXPIRED. We disable
  // reconnection first to break the otherwise-infinite retry loop (the
  // server will keep rejecting handshakes until the user re-authenticates).
  socketInstance.on('connect_error', (err: Error) => {
    if (err.message !== SESSION_EXPIRED_ERROR) return;
    if (sessionExpiredHandled) return;
    sessionExpiredHandled = true;
    socketInstance?.disconnect();
    void signOut({ redirect: true, callbackUrl: '/login' });
  });

  return socketInstance;
}

/**
 * Subscribe the active socket to a channel room by emitting
 * `subscribe:channel`. The server-side handler in `lib/realtime/io.ts`
 * receives this event and joins the socket to `channel:{channelId}`,
 * which is the room targeted by `message:new` broadcasts.
 *
 * If the socket has never been constructed, this call lazily creates it
 * via {@link getClientSocket}.
 *
 * MVP scope: there is no `unsubscribe:channel` round-trip. Leaving the
 * room is handled implicitly when the socket disconnects, and the next
 * call simply joins a different room. Components viewing only one
 * channel at a time can call this helper from a `useEffect` and not worry
 * about cleanup.
 *
 * @param channelId - The channel id to subscribe to. Empty strings are
 *   ignored to avoid accidentally joining `channel:`.
 */
export function subscribeToChannel(channelId: string): void {
  if (typeof channelId !== 'string' || channelId.length === 0) {
    return;
  }
  const socket = getClientSocket();
  socket.emit('subscribe:channel', channelId);
}
