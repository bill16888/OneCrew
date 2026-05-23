/**
 * Agentic-loop event emitter (process-wide singleton).
 *
 * The Agentic Loop and the Approval Service are decoupled by a small
 * Node `EventEmitter` so approval decisions can wake up — or cancel —
 * an in-flight AI decision cycle without waiting for the next 30-second
 * `setInterval` tick.
 *
 * Channels carried on this emitter:
 *
 * - `wakeup`: emitted by `ApprovalService.approve(id)` after the row has
 *   transitioned `PENDING → APPROVED`. The Agentic Loop listens and
 *   immediately runs `runForAI(aiUserId)` for the unblocked AI, instead
 *   of waiting for the next 30 s tick.
 * - `reject`: emitted by `ApprovalService.reject(id)` after the row has
 *   transitioned `PENDING → REJECTED`. The Agentic Loop / AI Runtime
 *   uses it to terminate the in-flight cycle of the requesting AI with
 *   `finishReason = 'rejected'`. No `wakeup` is emitted on rejection.
 *
 * Why a singleton with a `globalThis` cache?
 * Next.js development mode hot-reloads modules on every file change.
 * Without caching, each reload would create a fresh `EventEmitter` and
 * the previously-registered Agentic Loop listeners would silently stop
 * receiving events emitted by newly-loaded service modules. Reusing one
 * emitter across reloads keeps the wakeup / reject wiring intact during
 * development, mirroring the pattern used by `lib/prisma.ts`.
 *
 * In production the module is evaluated exactly once per process, so
 * the global cache is unused and the emitter lives for the lifetime of
 * the process.
 *
 * Reference: design.md → "Agentic Loop（30s setInterval + EventEmitter
 * 唤醒）"; requirements 6.6 (immediate wakeup on APPROVED) and 7.2
 * (per-AI cycle scheduling).
 *
 * @example
 * ```ts
 * // In ApprovalService.approve(id):
 * import { agenticEmitter } from '@/lib/loop/emitter';
 * await prisma.approval.update({ ... });
 * agenticEmitter.emit('wakeup', approval.aiUserId);
 *
 * // In AgenticLoop.start():
 * import { agenticEmitter } from '@/lib/loop/emitter';
 * agenticEmitter.on('wakeup', (aiUserId) => void runForAI(aiUserId));
 * ```
 */

import { env } from '@/lib/env';
import { EventEmitter } from 'node:events';

/**
 * Strongly-typed map of every event the Agentic Loop cares about.
 *
 * Each key maps to the **tuple of arguments** carried by the event,
 * matching Node 20's native `EventMap` convention. This lets
 * TypeScript verify both the `emit` arguments and the listener
 * parameters at every call site, so we never accidentally drift
 * between emitter and consumer.
 *
 * Declared as a `type` alias of an object literal so it satisfies the
 * `Record<string, unknown[]>` constraint on {@link TypedEmitter}.
 */
export type AgenticEvents = {
  /**
   * Wake up the Agentic Loop for a specific AI colleague.
   *
   * Emitted after an `Approval` row has been persisted as `APPROVED`.
   * Listeners should invoke a new decision cycle for the given AI
   * without waiting for the next periodic tick.
   *
   * Tuple shape: `[aiUserId]` — `User.id` of the AI colleague to wake.
   */
  wakeup: [aiUserId: string];

  /**
   * Cancel the in-flight decision cycle for a specific AI colleague.
   *
   * Emitted after an `Approval` row has been persisted as `REJECTED`.
   * Listeners should terminate any running cycle for the given AI with
   * `finishReason = 'rejected'`.
   *
   * Tuple shape: `[aiUserId]` — `User.id` of the AI colleague whose
   * cycle should be terminated.
   */
  reject: [aiUserId: string];
};

/**
 * `EventEmitter` re-typed against an event map of argument tuples.
 *
 * Defined as a standalone structural interface (rather than extending
 * the built-in `EventEmitter` class) so the per-event listener types
 * do not collide with the generic `EventEmitter<DefaultEventMap>`
 * shipped by `@types/node` 20+. Only the methods the Agentic Loop
 * actually uses are surfaced; callers who need additional EventEmitter
 * APIs can fall back to the underlying instance via an `as EventEmitter`
 * cast, but the typed surface is enough for `wakeup` / `reject`.
 *
 * @typeParam Events - Event-name → argument-tuple map.
 */
export interface TypedEmitter<Events extends Record<string, unknown[]>> {
  on<E extends keyof Events & string>(
    event: E,
    listener: (...args: Events[E]) => void,
  ): this;
  once<E extends keyof Events & string>(
    event: E,
    listener: (...args: Events[E]) => void,
  ): this;
  off<E extends keyof Events & string>(
    event: E,
    listener: (...args: Events[E]) => void,
  ): this;
  addListener<E extends keyof Events & string>(
    event: E,
    listener: (...args: Events[E]) => void,
  ): this;
  removeListener<E extends keyof Events & string>(
    event: E,
    listener: (...args: Events[E]) => void,
  ): this;
  removeAllListeners<E extends keyof Events & string>(event?: E): this;
  listenerCount<E extends keyof Events & string>(event: E): number;
  setMaxListeners(n: number): this;
  emit<E extends keyof Events & string>(event: E, ...args: Events[E]): boolean;
}

/**
 * The concrete emitter type used across the Agentic Loop wiring.
 *
 * Always import {@link agenticEmitter} rather than constructing your
 * own `EventEmitter`; otherwise approval-driven wakeups will not reach
 * the Agentic Loop.
 */
export type AgenticEmitter = TypedEmitter<AgenticEvents>;

/**
 * Maximum listener count for the singleton emitter.
 *
 * Node's default of 10 is plenty for the MVP (one Agentic Loop
 * subscriber per channel), but we set a higher explicit cap so that
 * test suites — which may attach short-lived spy listeners across many
 * iterations — and future feature work do not trip the
 * `MaxListenersExceededWarning`.
 */
const MAX_LISTENERS = 50;

/**
 * Shape of the Node global with our cached emitter attached. Using a
 * dedicated, namespaced key keeps the singleton fully typed without
 * leaking `any` into call sites or polluting `globalThis` typings.
 */
type GlobalWithAgenticEmitter = typeof globalThis & {
  __agenticEmitter__?: AgenticEmitter;
};

const globalForEmitter = globalThis as GlobalWithAgenticEmitter;

/**
 * Build a fresh emitter configured for the agentic-loop workload.
 *
 * `EventEmitter` is structurally compatible with {@link TypedEmitter};
 * the cast narrows the API surface visible to callers without changing
 * the runtime instance.
 */
function createAgenticEmitter(): AgenticEmitter {
  const emitter = new EventEmitter() as unknown as AgenticEmitter;
  emitter.setMaxListeners(MAX_LISTENERS);
  return emitter;
}

/**
 * Process-wide agentic event emitter.
 *
 * - In production: created once per process at module load.
 * - In development: cached on `globalThis.__agenticEmitter__` so
 *   Next.js HMR reloads do not orphan previously-registered listeners.
 */
export const agenticEmitter: AgenticEmitter =
  globalForEmitter.__agenticEmitter__ ?? createAgenticEmitter();

if (env.NODE_ENV !== 'production') {
  globalForEmitter.__agenticEmitter__ = agenticEmitter;
}
