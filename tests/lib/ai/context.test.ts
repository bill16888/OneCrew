/**
 * @file Property tests for `lib/ai/context.ts`.
 *
 * Covers Property 23 (上下文截断保留尾部): for any conversation and
 * any token budget, `trimContextToTokenBudget` returns a contiguous
 * SUFFIX of the input whose total estimated tokens are `≤ budget`.
 *
 * Validates: Requirements 7.5, design.md Property 23 (P2 task 6.11).
 */

import '../../setup';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  estimateTokens,
  trimContextToTokenBudget,
} from '@/lib/ai/context';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Random conversation. We bias content lengths low so most messages
// fit individually; token-count budgets up to ~10x the per-message
// max ensures both "fits everything" and "drops most" cases occur.
const arbMessage: fc.Arbitrary<ConversationMessage> = fc.record({
  role: fc.constantFrom('user', 'assistant') as fc.Arbitrary<
    'user' | 'assistant'
  >,
  content: fc.string({ minLength: 0, maxLength: 200 }),
});
const arbConversation: fc.Arbitrary<ConversationMessage[]> = fc.array(
  arbMessage,
  { minLength: 0, maxLength: 30 },
);
const arbBudget: fc.Arbitrary<number> = fc.integer({ min: 0, max: 2000 });

describe('Feature: ai-native-team-workspace, Property 23: 上下文截断保留尾部', () => {
  it('returns a contiguous suffix whose total tokens ≤ budget', () => {
    fc.assert(
      fc.property(
        arbConversation,
        arbBudget,
        (messages, budget) => {
          const trimmed = trimContextToTokenBudget(messages, budget);

          // 1. Slice is a contiguous suffix of the original array.
          const startIndex = messages.length - trimmed.length;
          const suffix = messages.slice(startIndex);
          expect(trimmed).toEqual(suffix);

          // 2. Total estimated tokens fit in the budget. Edge case:
          //    when budget is 0 the result must be empty even if the
          //    original is empty (suffix length 0 satisfies both).
          const total = trimmed.reduce(
            (acc, m) => acc + estimateTokens(m.content),
            0,
          );
          expect(total).toBeLessThanOrEqual(budget);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns [] when budget ≤ 0 even with non-empty input', () => {
    fc.assert(
      fc.property(arbConversation, fc.integer({ min: -100, max: 0 }), (m, b) => {
        expect(trimContextToTokenBudget(m, b)).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });
});

describe('estimateTokens — supporting properties', () => {
  it('is monotonic over string length: longer string ⇒ ≥ tokens', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        fc.string({ minLength: 0, maxLength: 200 }),
        (a, b) => {
          if (a.length === b.length) return; // skip ties
          const longer = a.length > b.length ? a : b;
          const shorter = a.length > b.length ? b : a;
          expect(estimateTokens(longer)).toBeGreaterThanOrEqual(
            estimateTokens(shorter),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns 0 for null / undefined', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});
