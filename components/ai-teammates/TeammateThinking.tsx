'use client';

/**
 * Mount-once global subscriber that mirrors the server-side
 * `ai:thinking` realtime events into the Zustand workspace store.
 *
 * Task 11.4 — surface AI thinking state in the UI:
 *   - The AI Runtime's `runCycle` broadcasts `ai:thinking { aiUserId,
 *     state }` exactly once at the start of a decision cycle (`state:
 *     true`) and again in the `finally` block (`state: false`),
 *     regardless of how the cycle terminates (Property 24,
 *     Requirements 7.6, 7.7).
 *   - Components that want to render a thinking indicator next to an
 *     AI avatar simply read `useWorkspaceStore(s => s.thinkingAIs)`.
 *     This component is the lone subscriber that keeps that set in
 *     sync; no other component should subscribe directly to the socket
 *     for this event.
 *
 * Lifecycle:
 *   - Mounted once at the workspace shell level (see
 *     `app/(workspace)/layout.tsx`). Behaves like a singleton — we
 *     attach exactly one listener for the lifetime of the shell.
 *   - Renders nothing (`return null`); it exists purely for its side
 *     effect of bridging the socket to the store.
 *
 * On unmount the listener is removed so React Fast Refresh and route
 * group remounts do not leak duplicate subscriptions; the underlying
 * Socket.io singleton from `lib/realtime/client.ts` is preserved across
 * remounts.
 *
 * Validates: Requirements 7.6, 7.7
 */

import { useEffect } from 'react';

import type { AIThinkingPayload } from '@/lib/realtime/events';
import { useSocket } from '@/hooks/useSocket';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

export function TeammateThinking(): null {
  const { socket } = useSocket();

  useEffect(() => {
    // Pull the actions through `getState()` so the effect's dependency
    // list stays minimal (the store actions are stable references, but
    // referencing them via the hook would also work — `getState()`
    // simply makes the side-effect-only nature of this component
    // explicit at the call site).
    const { addThinking, removeThinking } = useWorkspaceStore.getState();

    const handleAIThinking = (payload: AIThinkingPayload): void => {
      // Defensive: the wire payload is typed but the network is not
      // trusted. Guard against malformed events so a single bad emit
      // never poisons the thinking set.
      if (typeof payload?.aiUserId !== 'string' || payload.aiUserId.length === 0) {
        return;
      }
      if (payload.state === true) {
        addThinking(payload.aiUserId);
      } else if (payload.state === false) {
        removeThinking(payload.aiUserId);
      }
    };

    socket.on('ai:thinking', handleAIThinking);
    return () => {
      socket.off('ai:thinking', handleAIThinking);
    };
  }, [socket]);

  return null;
}
