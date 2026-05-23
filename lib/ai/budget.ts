/**
 * @file Daily AI token-spend budget tracker with hard circuit breaker.
 *
 * Why this exists:
 *
 * The Agentic Loop wakes every {@link env.AI_AGENT_INTERVAL_MS}
 * milliseconds and may issue up to 5 model calls per AI per cycle.
 * Without a budget guard, a misbehaving prompt or a runaway tool loop
 * could rack up large bills overnight. This module accumulates a coarse
 * USD estimate of every model response and trips a circuit breaker
 * once the day's spend crosses {@link env.AI_DAILY_BUDGET_USD}.
 *
 * Budget semantics:
 *
 * - `track(usage)` is called by the AI runtime after every successful
 *   chat completion response. It estimates the call's cost from the
 *   {@link MODEL_PRICING} table, adds it to today's running total, and
 *   — only if the new total strictly exceeds the configured daily
 *   limit — throws an `Error('AI_BUDGET_EXCEEDED')`. Note that the
 *   throw is informational: callers (the AI runtime) catch it, log it,
 *   and gracefully short-circuit the rest of the cycle.
 * - "Today" is the UTC calendar day. A `track()` call that lands after
 *   UTC midnight automatically resets the running total before adding
 *   the new sample, so the limit is a rolling 24-hour window aligned
 *   to UTC 00:00.
 * - `getStats()` is a read-only view used by `/api/admin/budget` and
 *   the runtime's structured logs. It does not roll the window over;
 *   the next `track()` call will do that.
 * - `reset()` is exposed for unit tests; production code should never
 *   call it.
 *
 * Singleton model:
 *
 * The tracker carries process-wide mutable state (today's spend) and
 * MUST be shared across every `runCycle` invocation. We follow the
 * same `globalThis` cache pattern used by `lib/prisma.ts` and
 * `lib/loop/emitter.ts` so Next.js hot module reloads in development
 * do not orphan the running tally.
 *
 * Validates: Operational concerns (P0 fix #3 — daily budget circuit breaker).
 */

import { env } from '@/lib/env';

/**
 * Sentinel error code thrown by {@link Budget.track} after the daily
 * limit has been exceeded. Callers MAY pattern-match on `err.message`
 * (or `err instanceof Error && err.message === BUDGET_EXCEEDED_CODE`)
 * to handle the breaker without re-throwing.
 */
export const BUDGET_EXCEEDED_CODE = 'AI_BUDGET_EXCEEDED';

/**
 * Per-million-token pricing for the model the runtime currently uses.
 *
 * IMPORTANT: keep this in sync with the model id pinned in
 * `lib/ai/anthropic.ts` (which reads `env.DEEPSEEK_MODEL`, defaulting
 * to `deepseek-chat`). Pricing source / last verified:
 *
 *   - DeepSeek-chat (off-peak / non-cache-hit input): $1.07 per
 *     1,000,000 input tokens, $1.10 per 1,000,000 output tokens.
 *     Cache-hit input is cheaper (~$0.27 / M) but the SDK response we
 *     consume does not surface a hit / miss split, so we conservatively
 *     bill all input at the cache-MISS rate. That biases the breaker
 *     toward tripping a touch early — which is the right direction for
 *     a cost guard.
 *
 *   - Last verified: 2026-05-23 against DeepSeek's published pricing
 *     page (https://api-docs.deepseek.com/quick_start/pricing).
 *     Re-check whenever DeepSeek announces a price change or whenever
 *     `env.DEEPSEEK_MODEL` is pointed at a different model.
 *
 * The cost estimator is intentionally coarse:
 *   - We do not subtract any tool-use tokens — they count as part of
 *     the assistant's output, which is what `output_tokens` already
 *     measures, so no further adjustment is needed.
 *   - The OpenAI-compatible response from DeepSeek surfaces
 *     `prompt_tokens` / `completion_tokens`; the bridge in
 *     `lib/ai/openai-bridge.ts` renames them to `input_tokens` /
 *     `output_tokens` before they reach this module so the field
 *     names line up with the formula below.
 */
export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMillion: number;
}

/**
 * Pricing table keyed by chat model id. Add a new entry whenever
 * `env.DEEPSEEK_MODEL` is pointed at a different model. Keys match
 * exactly the strings DeepSeek's API echoes back in
 * `chat.completions.create({...}).model`.
 *
 * Source: DeepSeek public pricing page. Re-verify when changing models.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // Default chat model. Cache-MISS input rate so the breaker trips
  // conservatively early (see file-level JSDoc).
  'deepseek-chat': { inputPerMillion: 1.07, outputPerMillion: 1.1 },
  // Chain-of-thought / reasoning model. Same pricing tier today; if
  // DeepSeek splits this in the future, update both numbers here.
  'deepseek-reasoner': { inputPerMillion: 1.07, outputPerMillion: 1.1 },
};

/**
 * Default pricing applied when an unrecognised model id reaches
 * {@link estimateCostUSD}. We pick the deepseek-chat rate because
 * that is the model the runtime defaults to, and keeping the
 * fallback non-zero ensures the breaker still functions on novel
 * model ids.
 */
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 1.07,
  outputPerMillion: 1.1,
};

/**
 * Subset of a model `usage` payload we actually consume. The bridge
 * in `lib/ai/openai-bridge.ts` renames OpenAI's `prompt_tokens` /
 * `completion_tokens` to `input_tokens` / `output_tokens` before they
 * reach this module, so the upstream contract here is stable across
 * any future provider swap.
 */
export interface UsageSample {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/**
 * Compute the USD cost of a single API call given its usage and the
 * model that produced it.
 *
 * Negative or non-finite token counts are clamped to zero so a
 * malformed `usage` payload cannot accidentally credit the budget back.
 *
 * @param usage  Token counts (already normalised to
 *   `input_tokens` / `output_tokens` by the bridge).
 * @param model  Model id that produced the response. Defaults to the
 *   chat model the runtime currently pins.
 * @returns      USD cost as a `number`. Always `≥ 0`.
 */
export function estimateCostUSD(
  usage: UsageSample,
  model = 'deepseek-chat',
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const input = Number.isFinite(usage.input_tokens)
    ? Math.max(0, usage.input_tokens)
    : 0;
  const output = Number.isFinite(usage.output_tokens)
    ? Math.max(0, usage.output_tokens)
    : 0;
  return (
    (input * pricing.inputPerMillion) / 1_000_000 +
    (output * pricing.outputPerMillion) / 1_000_000
  );
}

/**
 * Snapshot returned by {@link Budget.getStats}. Safe to serialise
 * straight to JSON.
 */
export interface BudgetStats {
  /** USD spent today (UTC). Resets at the next UTC midnight. */
  readonly todayUSD: number;
  /** Configured daily limit (`env.AI_DAILY_BUDGET_USD`). */
  readonly limitUSD: number;
  /** When the running tally next resets (next UTC 00:00). */
  readonly resetAt: Date;
}

/**
 * Compute the next UTC midnight strictly after `now`.
 */
function nextUtcMidnight(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

/**
 * Encapsulated budget tracker. Mutable state is intentionally scoped
 * to this class so the {@link globalThis}-cached singleton below is
 * the *only* reachable instance in the process; tests can still drive
 * the type directly via `new Budget()` if they need an isolated
 * fixture (the singleton's {@link reset} method is the public escape
 * hatch otherwise).
 */
export class Budget {
  /** USD spent in the current UTC day. */
  private todayUSD = 0;

  /** UTC midnight after which the running tally must be reset. */
  private resetAt: Date = nextUtcMidnight(new Date());

  /**
   * Roll the running tally over to a new UTC day if necessary.
   *
   * Called at the top of every public mutator. We compare against the
   * cached `resetAt` so the reset point stays stable within a day; on
   * crossing it we move `resetAt` to the next UTC midnight relative to
   * the current clock.
   */
  private rolloverIfNeeded(now: Date): void {
    if (now.getTime() >= this.resetAt.getTime()) {
      this.todayUSD = 0;
      this.resetAt = nextUtcMidnight(now);
    }
  }

  /**
   * Account for one chat completion API call.
   *
   * Steps:
   *   1. Roll over to a new UTC day if the previous `resetAt` has passed.
   *   2. Add the estimated USD cost of `usage` to the running tally.
   *   3. If the new tally strictly exceeds {@link env.AI_DAILY_BUDGET_USD},
   *      throw an `Error('AI_BUDGET_EXCEEDED')`. The throw is informational:
   *      the caller is expected to catch it, surface a system message,
   *      and stop further calls for the day. The accumulated total is
   *      kept (NOT rolled back) so subsequent `getStats()` reflects the
   *      true overshoot.
   *
   * @param usage Token counts (post-bridge: `input_tokens` /
   *   `output_tokens`).
   * @param model Optional model id; defaults to the runtime's pin.
   * @throws  `Error('AI_BUDGET_EXCEEDED')` once the tally exceeds the
   *   configured daily limit.
   */
  track(usage: UsageSample, model?: string): void {
    const now = new Date();
    this.rolloverIfNeeded(now);

    const cost = estimateCostUSD(usage, model);
    this.todayUSD += cost;

    if (this.todayUSD > env.AI_DAILY_BUDGET_USD) {
      throw new Error(BUDGET_EXCEEDED_CODE);
    }
  }

  /**
   * Return a JSON-safe snapshot of today's spend, the configured limit,
   * and the next UTC reset point. This call is non-mutating: it does
   * NOT roll the window over, so a long-running observer still sees
   * the previous day's final tally until the next `track()`.
   */
  getStats(): BudgetStats {
    return {
      todayUSD: this.todayUSD,
      limitUSD: env.AI_DAILY_BUDGET_USD,
      resetAt: new Date(this.resetAt),
    };
  }

  /**
   * Reset today's spend to zero and recompute `resetAt`. Exposed for
   * unit tests only; production code MUST NOT call this.
   */
  reset(): void {
    this.todayUSD = 0;
    this.resetAt = nextUtcMidnight(new Date());
  }
}

/**
 * Shape of `globalThis` with our cached singleton attached. Mirrors the
 * pattern used by `lib/prisma.ts` and `lib/loop/emitter.ts` so HMR in
 * development never orphans the running tally.
 */
type GlobalWithBudget = typeof globalThis & {
  __aiBudget__?: Budget;
};

const globalForBudget = globalThis as GlobalWithBudget;

/**
 * Process-wide budget singleton. Always import this — never instantiate
 * a fresh `new Budget()` from production code, otherwise the cycle that
 * "owns" the budget will diverge from the cycle that reads it.
 *
 * @example
 * ```ts
 * import { budget, BUDGET_EXCEEDED_CODE } from '@/lib/ai/budget';
 *
 * try {
 *   budget.track(response.usage);
 * } catch (err) {
 *   if (err instanceof Error && err.message === BUDGET_EXCEEDED_CODE) {
 *     // Surface a system message; do not start another round.
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export const budget: Budget =
  globalForBudget.__aiBudget__ ?? (globalForBudget.__aiBudget__ = new Budget());
