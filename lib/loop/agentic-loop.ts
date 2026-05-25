/**
 * @file Agentic Loop: periodic AI decision-cycle scheduler.
 *
 * The Agentic Loop is the long-running scheduler that drives every
 * AI colleague through one bounded `runCycle` per period. It runs
 * inside the same Node process as Next.js HTTP and Socket.io so all
 * three layers can share the singleton {@link agenticEmitter} and the
 * shared Prisma client.
 *
 * Responsibilities:
 *
 *   1. **Periodic tick** — every {@link TICK_MS} ms (= 30 s) the loop
 *      lists every AI user (`User.isAI === true`) and schedules a
 *      cycle for each one (Requirement 7.1).
 *   2. **Approval gating** — before starting a cycle for an AI, we ask
 *      {@link ApprovalService.listPendingForAI} whether that AI is
 *      currently blocked. A non-empty result means at least one
 *      approval is `PENDING`; the cycle is skipped entirely until the
 *      next tick or wakeup (Requirement 6.5).
 *   3. **In-flight protection** — a module-level {@link inFlight} set
 *      ensures at most one cycle per AI runs at any moment, even when
 *      a wakeup event fires while a periodic tick has the same AI
 *      mid-cycle (Requirement 7.2).
 *   4. **Immediate wakeup** — subscribing to `agenticEmitter.on('wakeup',
 *      aiUserId)` lets the approval service resume the AI's cycle the
 *      instant a `PENDING → APPROVED` transition commits, instead of
 *      waiting up to 30 s for the next tick (Requirements 6.6, 7.2).
 *      Rejections are surfaced on a separate `'reject'` channel and
 *      only signal in-cycle cancellation; they intentionally do **not**
 *      start a new cycle here, so the Agentic Loop attaches no
 *      listener for `'reject'` during {@link start}.
 *   5. **Fault isolation** — both the top-level {@link tick} and each
 *      per-AI {@link runForAI} are wrapped in `try/catch`; any thrown
 *      error is logged and swallowed so the next tick still fires on
 *      schedule and one misbehaving AI cannot starve its peers
 *      (Requirements 7.6, 7.7, 10.6).
 *
 * Reference: design.md → "Agentic Loop（30s setInterval + EventEmitter
 * 唤醒）"; requirements.md → 6.5, 6.6, 7.1, 7.2, 7.6, 7.7, 10.6.
 *
 * Validates: Requirements 6.5, 6.6, 7.1, 7.2, 7.6, 7.7, 10.6
 *
 * @example
 * ```ts
 * // server.ts — wired in task 10.2
 * import { createIOServer } from '@/lib/realtime/io';
 * import { AgenticLoop } from '@/lib/loop/agentic-loop';
 *
 * const io = createIOServer(httpServer);
 * AgenticLoop.start(io);
 * // …on shutdown:
 * AgenticLoop.stop();
 * ```
 */

import { AIRuntime } from '@/lib/ai/runtime';
import { BUDGET_EXCEEDED_CODE, budget } from '@/lib/ai/budget';
import { env } from '@/lib/env';
import { agenticEmitter } from '@/lib/loop/emitter';
import prisma from '@/lib/prisma';
import type { AppIOServer } from '@/lib/realtime/io';
import { ApprovalService } from '@/lib/services/approval.service';

// ---------------------------------------------------------------------------
// Constants and module state
// ---------------------------------------------------------------------------

/**
 * Period of the {@link tick} scheduler in milliseconds. Fixed at 30 s by
 * Requirement 7.1; exported so tests can compare against the contract
 * without re-deriving the constant.
 */
export const TICK_MS = 30_000;

/**
 * Set of AI user ids whose `runForAI` is currently mid-flight.
 *
 * Two scheduling sources (the periodic {@link tick} and the
 * `agenticEmitter.on('wakeup', …)` listener) can each invoke
 * {@link runForAI} for the same AI. Without a guard, a wakeup that
 * fires while a tick-driven cycle is still talking to Anthropic would
 * spawn a second concurrent cycle for the same AI — burning tokens and
 * potentially producing duplicate side effects. The {@link inFlight}
 * set is the single source of truth for "this AI already has a cycle
 * running", and is mutated only inside {@link runForAI} (add before
 * calling `runCycle`, delete in `finally`).
 *
 * The set lives at module scope (rather than per-call) because it must
 * be visible across all schedulers feeding into the same loop.
 */
const inFlight = new Set<string>();

/**
 * The active `setInterval` handle, or `null` when the loop is stopped.
 *
 * Tracked at module scope so {@link stop} can clear the handle without
 * the caller having to thread it back in. We use
 * `ReturnType<typeof setInterval>` rather than `NodeJS.Timeout` so the
 * type works under both `@types/node` and bundler environments that
 * substitute the DOM lib's narrower `number` return type.
 */
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Listener registered with {@link agenticEmitter} during {@link start}.
 *
 * Held at module scope so {@link stop} can detach exactly this
 * listener. We avoid `removeAllListeners('wakeup')` because the same
 * emitter is process-global (cached on `globalThis` in
 * `lib/loop/emitter.ts`), and ripping every listener off the channel
 * would also unsubscribe other modules — including the AI Runtime's
 * own `'reject'` cancellation logic landing in task 9.x — that share
 * the singleton.
 */
let wakeupListener: ((aiUserId: string) => void) | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Structured-error logger used for both tick-level and per-AI failures.
 *
 * The MVP uses `console.error` so the loop stays self-contained; task
 * 11.3 swaps in the real pino logger. The shape of the logged record
 * (`event`, `aiUserId`, `error`) matches the conventions established by
 * `lib/ai/runtime.ts` so log aggregators can correlate cycle failures
 * with the surrounding tick.
 */
function logLoopError(
  event: 'agentic_tick_error' | 'agentic_run_for_ai_error',
  err: unknown,
  aiUserId?: string,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      event,
      ...(aiUserId !== undefined ? { aiUserId } : {}),
      error: message,
      ...(stack !== undefined ? { stack } : {}),
    }),
  );
}

/**
 * Schedule (or skip) a single decision cycle for one AI colleague.
 *
 * Gating order matches design.md exactly:
 *
 *   1. **inFlight check.** If the AI already has a cycle in flight,
 *      return immediately. This is the de-duplication guard between
 *      the periodic tick and the wakeup listener.
 *   2. **PENDING approval check.** Ask
 *      {@link ApprovalService.listPendingForAI}; a non-empty result
 *      means the human has not yet decided on at least one of this
 *      AI's outstanding requests, so we MUST NOT start a new cycle
 *      (Requirement 6.5). Note that this check happens *after* the
 *      inFlight guard so an in-progress cycle for the same AI doesn't
 *      get billed for an extra Prisma read.
 *   3. **Cycle execution.** Add the AI to {@link inFlight}, invoke
 *      `AIRuntime.runCycle`, and remove from `inFlight` in `finally`
 *      regardless of whether `runCycle` succeeded or threw. The
 *      `try/catch` here (Requirement 10.6) ensures one AI's failure
 *      does not propagate up to {@link tick} or the wakeup listener.
 *
 * The function never throws: every error path is logged via
 * {@link logLoopError} and consumed locally. Callers may therefore
 * fire-and-forget, e.g. `void runForAI(aiUserId)` from a synchronous
 * event listener.
 *
 * @param aiUserId `User.id` of the AI colleague to schedule.
 *
 * @example
 * ```ts
 * // From the periodic tick:
 * await Promise.all(ais.map((ai) => runForAI(ai.id)));
 *
 * // From the wakeup listener:
 * agenticEmitter.on('wakeup', (aiUserId) => void runForAI(aiUserId));
 * ```
 */
async function runForAI(aiUserId: string): Promise<void> {
  // 1. De-dupe across periodic ticks and wakeup events.
  if (inFlight.has(aiUserId)) {
    return;
  }

  // 2. Approval-gating: any PENDING approval blocks a new cycle.
  //    `listPendingForAI` is a read-only Prisma query; a thrown error
  //    here (e.g. transient DB outage) is treated like any other
  //    in-cycle failure: log it and skip this turn so we try again on
  //    the next tick or wakeup.
  let pendingCount = 0;
  try {
    const pending = await ApprovalService.listPendingForAI(aiUserId);
    pendingCount = pending.length;
  } catch (err) {
    logLoopError('agentic_run_for_ai_error', err, aiUserId);
    return;
  }
  if (pendingCount > 0) {
    return;
  }

  // 3. Budget gate: skip this cycle when the daily AI budget has already
  //    been exceeded so we don't emit a short-lived `ai:thinking { true }`
  //    that is immediately cancelled inside `runCycle`. The runtime still
  //    performs its own per-call budget check as a mid-cycle safety net.
  if (budget.getStats().todayUSD >= budget.getStats().limitUSD) {
    return;
  }

  // 4. Run the cycle under the inFlight guard. The set membership is
  //    flipped synchronously around the awaited call so the guard
  //    holds across every async boundary inside `runCycle`.
  inFlight.add(aiUserId);
  try {
    await AIRuntime.runCycle(aiUserId);
  } catch (err) {
    // `runCycle` already converts in-cycle failures to a structured
    // RunCycleResult (`finishReason: 'retry_exhausted'`). The only
    // errors that escape are configuration-level (missing AI user,
    // unknown aiRole) — those are still scoped to a single AI, so we
    // log and move on to keep the scheduler alive (Requirement 10.6).
    logLoopError('agentic_run_for_ai_error', err, aiUserId);
  } finally {
    inFlight.delete(aiUserId);
  }
}

/**
 * One pass of the periodic scheduler.
 *
 * Lists every AI colleague (`User.isAI === true`) and fans out a call
 * to {@link runForAI} for each one. The fan-out runs in parallel via
 * `Promise.all` — `runForAI` is independently safe (it cannot throw,
 * and its inFlight guard de-duplicates against concurrent wakeup
 * events) so there is no need to serialize them.
 *
 * Both the user-listing query and the fan-out are wrapped in a single
 * top-level `try/catch`. A thrown error (e.g. transient DB outage or a
 * Prisma client crash) is logged and swallowed so the next
 * `setInterval` tick still fires on schedule (Requirement 10.6). We
 * never re-throw out of this function — `setInterval` would otherwise
 * surface the error as an unhandled rejection and the supervisor might
 * tear down the process.
 *
 * Each individual `runForAI` is additionally guarded by `.catch` so a
 * pathological rejection inside the promise chain (which `runForAI`'s
 * own try/catch should already prevent) cannot poison the
 * `Promise.all` aggregate result.
 */
async function tick(): Promise<void> {
  try {
    const ais = await prisma.user.findMany({
      where: { isAI: true },
      select: { id: true },
    });

    await Promise.all(
      ais.map((ai) =>
        runForAI(ai.id).catch((err) => {
          logLoopError('agentic_run_for_ai_error', err, ai.id);
        }),
      ),
    );
  } catch (err) {
    logLoopError('agentic_tick_error', err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the periodic Agentic Loop and wire the approval-driven wakeup
 * listener.
 *
 * Two scheduling sources are installed:
 *
 *   - **Periodic tick.** A `setInterval` fires {@link tick} every
 *     {@link TICK_MS} ms. The first tick is *not* invoked
 *     synchronously; it runs after one full interval, matching the
 *     `setInterval` semantics documented in design.md.
 *   - **Wakeup listener.** A handler is attached to
 *     `agenticEmitter.on('wakeup', aiUserId)` so an approval that
 *     transitions `PENDING → APPROVED` resumes the AI's cycle within
 *     ε of the database commit, regardless of when the next tick is
 *     scheduled (Property 19; Requirements 6.6, 7.2). The listener is
 *     captured in module-level state so {@link stop} can detach the
 *     exact handler on shutdown without disturbing other subscribers
 *     of the same process-global emitter.
 *
 * `start` is idempotent in the sense that calling it twice in a row
 * **without** an intervening {@link stop} is a programmer error — the
 * earlier interval would leak. We guard against that by stopping any
 * pre-existing scheduler before installing the new one. This makes the
 * loop safe under Next.js HMR reloads in development, which can re-
 * evaluate this module while the previous timer is still ticking.
 *
 * @param io The Socket.io server instance returned by `createIOServer`.
 *   Currently unused inside the loop itself: realtime broadcasts (e.g.
 *   `ai:thinking`) flow through `getIO()` from the runtime layer. The
 *   parameter is kept on the signature so server.ts (task 10.2) can
 *   pass the active server through, and so a future enhancement can
 *   reach into the IO instance without changing the call site.
 */
function start(io: AppIOServer): void {
  // Read once so the parameter is observably "used" under
  // `noUnusedParameters` lint rules without forcing callers to rename
  // it. We keep the parameter on the public signature for future use
  // (see JSDoc above).
  void io;

  // Defensive: if the loop is already running we tear it down first
  // so we never double-schedule under HMR or test re-initialization.
  if (timer !== null || wakeupListener !== null) {
    stop();
  }

  // Schedule periodic ticks. The periodic tick is *opt-in*: the
  // default deployment runs without it, so AIs only act when a human
  // mentions them or when an approval is granted. Operators flip
  // `AI_AUTO_TICK=true` for demos / live presentations where the
  // self-driving feel is desirable. The wakeup listener installed
  // below is wired in either case so @-mentions and approval flows
  // still work even when the timer is disabled.
  //
  // `tick()` is async-safe: it catches everything internally so the
  // timer callback resolves cleanly even when the body throws. We
  // deliberately ignore the returned Promise — `setInterval` does not
  // await, and unhandled rejections cannot happen because `tick`
  // catches its own errors.
  if (env.AI_AUTO_TICK) {
    const intervalMs = env.AI_AGENT_INTERVAL_MS;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        event: 'agentic_loop_started',
        mode: 'auto_tick',
        intervalMs,
      }),
    );
  } else {
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        event: 'agentic_loop_started',
        mode: 'on_mention_only',
      }),
    );
  }

  // Subscribe to immediate wakeup signals. The handler shape mirrors
  // `agenticEmitter`'s typed `wakeup` channel from `lib/loop/emitter.ts`.
  // We capture the listener so `stop` can detach exactly this function
  // without affecting other subscribers of the process-global emitter
  // (notably the AI Runtime's `reject` listener wired in task 9.x).
  wakeupListener = (aiUserId: string) => {
    // Fire-and-forget: `runForAI` never throws, so we don't need to
    // attach an extra `.catch`. The leading `void` makes the discard
    // explicit for both readers and lint rules.
    void runForAI(aiUserId);
  };
  agenticEmitter.on('wakeup', wakeupListener);
}

/**
 * Stop the periodic Agentic Loop and detach the wakeup listener.
 *
 * Tear-down order mirrors {@link start}:
 *
 *   1. Clear the `setInterval` so no further ticks fire.
 *   2. Detach the captured wakeup listener (see {@link start} for why
 *      we hold a module-scoped reference rather than calling
 *      `removeAllListeners('wakeup')`, which would also unsubscribe
 *      other modules sharing the process-global emitter).
 *
 * The function is idempotent: calling `stop` when the loop is already
 * stopped is a no-op. This makes shutdown handlers in `server.ts`
 * (`SIGINT`, `SIGTERM`) safe to call multiple times.
 *
 * In-flight cycles are not cancelled here. Any AI currently inside
 * `AIRuntime.runCycle` will run to completion; their `inFlight`
 * entries are removed by `runForAI`'s own `finally` block. Cycle
 * cancellation for individual AIs is handled by the `'reject'` channel
 * on the emitter, which is owned by the AI Runtime (task 9.x) and not
 * by this loop.
 */
function stop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }

  if (wakeupListener !== null) {
    agenticEmitter.off('wakeup', wakeupListener);
    wakeupListener = null;
  }
}

/**
 * Aggregated namespace export so callers can use either the named
 * imports or the `AgenticLoop.method(...)` style favored across the
 * spec (matching `AIRuntime`, `ApprovalService`, etc.).
 *
 * `start` and `stop` are the two public entry points. {@link TICK_MS}
 * is exported separately for tests; {@link inFlight}, {@link tick},
 * and {@link runForAI} stay module-private so the loop's internal
 * scheduling discipline cannot be subverted from outside.
 */
export const AgenticLoop = {
  start,
  stop,
} as const;
