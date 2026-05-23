/**
 * @file Property + smoke tests for `lib/ai/budget.ts`.
 *
 * Validates: P0 fix #3 — daily AI budget circuit breaker.
 *
 * The budget singleton is process-wide; we instantiate fresh `Budget`
 * objects directly to avoid bleeding state between tests.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  BUDGET_EXCEEDED_CODE,
  Budget,
  estimateCostUSD,
} from '@/lib/ai/budget';

describe('estimateCostUSD', () => {
  it('is non-negative for any token counts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (input, output) => {
          const cost = estimateCostUSD({
            input_tokens: input,
            output_tokens: output,
          });
          expect(cost).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(cost)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('clamps negative tokens to zero', () => {
    expect(
      estimateCostUSD({ input_tokens: -1000, output_tokens: -2000 }),
    ).toBe(0);
  });

  it('output is more expensive than equal input', () => {
    const inputCost = estimateCostUSD({
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    const outputCost = estimateCostUSD({
      input_tokens: 0,
      output_tokens: 1_000_000,
    });
    expect(outputCost).toBeGreaterThan(inputCost);
  });
});

describe('Budget.track / getStats', () => {
  it('accumulates spend until the daily limit, then throws', () => {
    const budget = new Budget();
    // Many calls that do NOT individually exceed the limit but
    // together must trip the breaker. The default limit is 5 USD; at
    // DeepSeek-chat output pricing ($1.10/M tokens) a 3M-output call
    // costs 3,000,000 / 1e6 * 1.10 = $3.30, so two calls cross the
    // threshold cumulatively without a single one being responsible.
    const usage = { input_tokens: 0, output_tokens: 3_000_000 };
    budget.track(usage); // 3.30 USD
    expect(budget.getStats().todayUSD).toBeCloseTo(3.3, 5);
    expect(() => budget.track(usage)).toThrow(BUDGET_EXCEEDED_CODE);
    // Spend is preserved (not rolled back) so the snapshot reflects
    // the true overshoot.
    expect(budget.getStats().todayUSD).toBeGreaterThan(5);
  });

  it('resetAt rolls forward to next UTC midnight', () => {
    const budget = new Budget();
    const stats = budget.getStats();
    expect(stats.resetAt.getUTCHours()).toBe(0);
    expect(stats.resetAt.getUTCMinutes()).toBe(0);
    expect(stats.resetAt.getUTCSeconds()).toBe(0);
  });
});
