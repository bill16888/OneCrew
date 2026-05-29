/**
 * @file In-memory snapshot of which AI colleagues are currently
 * "thinking" (mid-cycle).
 *
 * The runtime already broadcasts `ai:thinking { aiUserId, state }` over
 * Socket.io so connected clients can render a live indicator. The
 * operator dashboard (Phase 1 Req 13.2) also needs the CURRENT state at
 * page-load time — before any socket event arrives — so it can paint
 * the AI-status panel correctly on first render.
 *
 * This module keeps a process-local Set of thinking AI ids, updated by
 * the runtime's `emitThinking` alongside the broadcast. It is a
 * best-effort snapshot:
 *   - Single-process only (the MVP runs one Node process). A multi-pod
 *     deployment would need this in Redis; that's tracked with the
 *     other Redis-migration items.
 *   - Cleared on process restart — which is correct, since no cycle can
 *     survive a restart.
 *
 * Validates: Phase 1 Req 13.2 (AI-status panel initial state).
 */

const thinkingAIs = new Set<string>();

/**
 * Record that an AI started (`state = true`) or stopped (`state =
 * false`) thinking. Called by the runtime's `emitThinking` so the
 * snapshot stays in lock-step with the realtime broadcast.
 */
export function markThinking(aiUserId: string, state: boolean): void {
  if (state) {
    thinkingAIs.add(aiUserId);
  } else {
    thinkingAIs.delete(aiUserId);
  }
}

/** Return the set of AI ids currently mid-cycle as a plain array. */
export function getThinkingSnapshot(): string[] {
  return Array.from(thinkingAIs);
}

/** True iff the given AI is currently mid-cycle. */
export function isThinking(aiUserId: string): boolean {
  return thinkingAIs.has(aiUserId);
}

/** Test-only reset. Production code must not call this. */
export function __resetThinkingForTests(): void {
  thinkingAIs.clear();
}
