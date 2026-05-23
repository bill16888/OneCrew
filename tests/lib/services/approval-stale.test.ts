/**
 * @file Property tests for `ApprovalService.isStale`.
 *
 * Property 21 (陈旧审批检测):
 *   - For any approval with `now - createdAt > 24h`, isStale === true.
 *   - For any approval with `now - createdAt ≤ 24h`, isStale === false.
 *   - The function is pure: it never mutates the approval.
 *
 * Validates: Requirement 6.7 (P2 task 9.9).
 */

import '../../setup';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

// We avoid loading the full approval.service module (it imports
// prisma at the top level), and instead reach into the same logic by
// re-implementing the predicate from its public contract. Importing
// the named export still works because the lib doesn't actually open
// a DB connection at import time — but mocking prisma keeps the test
// isolation clean.

import { ApprovalService } from '@/lib/services/approval.service';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

describe('Feature: ai-native-team-workspace, Property 21: 陈旧审批检测', () => {
  it('returns true when now - createdAt > 24h', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: STALE_THRESHOLD_MS + 1, max: 7 * STALE_THRESHOLD_MS }),
        (deltaMs) => {
          const now = new Date('2025-01-15T00:00:00.000Z');
          const createdAt = new Date(now.getTime() - deltaMs);
          expect(ApprovalService.isStale({ createdAt }, now)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns false when now - createdAt ≤ 24h', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: STALE_THRESHOLD_MS }),
        (deltaMs) => {
          const now = new Date('2025-01-15T00:00:00.000Z');
          const createdAt = new Date(now.getTime() - deltaMs);
          expect(ApprovalService.isStale({ createdAt }, now)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not mutate the approval object', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * STALE_THRESHOLD_MS }), (d) => {
        const createdAt = new Date(Date.now() - d);
        const approval = Object.freeze({ createdAt }) as { createdAt: Date };
        // If isStale tried to mutate the frozen object, this would throw
        // in strict mode; we rely on that as the mutation guard.
        expect(() => ApprovalService.isStale(approval)).not.toThrow();
      }),
      { numRuns: 50 },
    );
  });
});
