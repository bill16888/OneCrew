'use client';

/**
 * React hook exposing the singleton Socket.io client and a live `connected`
 * flag derived from the underlying transport's `connect` / `disconnect`
 * events.
 *
 * The hook is intentionally thin: it does not manage subscriptions to
 * domain events (`message:new`, `task:updated`, …). Components subscribe
 * to those events directly on the returned `socket` so that listener
 * registration stays scoped to the component that renders the data.
 *
 * Reconnection is handled by the shared client (see
 * {@link ../lib/realtime/client.getClientSocket}); this hook simply
 * reflects the current connection state so UI can render an offline
 * indicator while the automatic reconnect runs in the background
 * (Requirements 8.7).
 *
 * @returns An object containing:
 *   - `socket`: the singleton {@link AppClientSocket}.
 *   - `connected`: `true` while the transport is open, `false` otherwise.
 *
 * @example
 * ```tsx
 * 'use client';
 * import { useSocket } from '@/hooks/useSocket';
 *
 * export function ChannelView({ channelId }: { channelId: string }) {
 *   const { socket, connected } = useSocket();
 *   useEffect(() => {
 *     const onMessage = (m: MessageNewPayload) => { ... };
 *     socket.on('message:new', onMessage);
 *     return () => { socket.off('message:new', onMessage); };
 *   }, [socket]);
 *   return connected ? <Live /> : <Reconnecting />;
 * }
 * ```
 */

import { useEffect, useState } from 'react';

import {
  getClientSocket,
  type AppClientSocket,
} from '@/lib/realtime/client';

/**
 * Return value of {@link useSocket}. `socket` is stable across renders
 * (singleton); `connected` updates whenever the transport opens or closes.
 */
export interface UseSocketResult {
  /** Singleton browser-side Socket.io client. */
  socket: AppClientSocket;
  /** True while the underlying transport is connected. */
  connected: boolean;
}

/**
 * Subscribe to the singleton socket's connection lifecycle and expose the
 * current state to the component tree.
 *
 * @returns A {@link UseSocketResult} with the singleton socket and a live
 *   `connected` flag.
 */
export function useSocket(): UseSocketResult {
  const socket = getClientSocket();
  const [connected, setConnected] = useState<boolean>(socket.connected);

  useEffect(() => {
    // Sync the initial flag in case the transport completed its handshake
    // between `getClientSocket()` above and this effect running.
    setConnected(socket.connected);

    const handleConnect = (): void => setConnected(true);
    const handleDisconnect = (): void => setConnected(false);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, [socket]);

  return { socket, connected };
}
