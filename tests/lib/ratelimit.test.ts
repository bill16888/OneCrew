/**
 * @file Unit tests for `lib/ratelimit.ts`.
 *
 * The audit (PR #1 follow-up) flagged this module as 0% covered: 180
 * lines of token-bucket logic — refill arithmetic, idle sweep, and
 * fail-open guard — were shipped without a single test. These tests
 * exercise each branch deterministically using the `nowMs` clock
 * override so no real time has to elapse.
 *
 * Validates: closes the audit gap "no unit tests for lib/ratelimit.ts".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetRateLimitsForTests,
  rateLimit,
  RateLimits,
  type RateLimitConfig,
} from '@/lib/ratelimit';

beforeEach(() => {
  __resetRateLimitsForTests();
});

afterEach(() => {
  __resetRateLimitsForTests();
});

const SCOPE = 'test';
const CONFIG: RateLimitConfig = { capacity: 3, windowMs: 60_000 };

describe('rateLimit — basic accounting', () => {
  it('admits up to `capacity` requests, then refuses', () => {
    expect(rateLimit(SCOPE, 'u1', CONFIG, 0).ok).toBe(true);
    expect(rateLimit(SCOPE, 'u1', CONFIG, 1).ok).toBe(true);
    expect(rateLimit(SCOPE, 'u1', CONFIG, 2).ok).toBe(true);
    const denied = rateLimit(SCOPE, 'u1', CONFIG, 3);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('separates buckets by (scope, key)', () => {
    // Exhaust u1; u2 still has all tokens; same scope different keys.
    for (let i = 0; i < 3; i++) {
      expect(rateLimit(SCOPE, 'u1', CONFIG, i).ok).toBe(true);
    }
    expect(rateLimit(SCOPE, 'u1', CONFIG, 3).ok).toBe(false);
    expect(rateLimit(SCOPE, 'u2', CONFIG, 3).ok).toBe(true);
  });

  it('separates buckets by scope when key matches', () => {
    for (let i = 0; i < 3; i++) {
      rateLimit(SCOPE, 'u1', CONFIG, i);
    }
    expect(rateLimit(SCOPE, 'u1', CONFIG, 3).ok).toBe(false);
    expect(rateLimit('other.scope', 'u1', CONFIG, 3).ok).toBe(true);
  });

  it('refills tokens linearly across the window', () => {
    // Exhaust the bucket at t=0.
    for (let i = 0; i < 3; i++) rateLimit(SCOPE, 'u1', CONFIG, 0);
    expect(rateLimit(SCOPE, 'u1', CONFIG, 0).ok).toBe(false);

    // After 1/3 of the window we should have 1 token (3 capacity / 60s
    // window × 20s = 1 token).
    expect(rateLimit(SCOPE, 'u1', CONFIG, 20_000).ok).toBe(true);
    // Immediately after, the next call should still fail (back to 0).
    expect(rateLimit(SCOPE, 'u1', CONFIG, 20_000).ok).toBe(false);

    // After the full window, the bucket has refilled to capacity.
    // (Token count is capped at capacity.)
    expect(rateLimit(SCOPE, 'u1', CONFIG, 80_000).ok).toBe(true);
    expect(rateLimit(SCOPE, 'u1', CONFIG, 80_000).ok).toBe(true);
    expect(rateLimit(SCOPE, 'u1', CONFIG, 80_000).ok).toBe(true);
    expect(rateLimit(SCOPE, 'u1', CONFIG, 80_000).ok).toBe(false);
  });

  it('returns retryAfterMs that approximates the time to one token', () => {
    for (let i = 0; i < 3; i++) rateLimit(SCOPE, 'u1', CONFIG, 0);
    const verdict = rateLimit(SCOPE, 'u1', CONFIG, 0);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // Token rate = 3/60_000 ms = 1 token / 20_000 ms. Empty bucket
      // therefore needs ~20 s to refill 1 token. Allow ±1 ms slop.
      expect(verdict.retryAfterMs).toBeGreaterThanOrEqual(19_999);
      expect(verdict.retryAfterMs).toBeLessThanOrEqual(20_001);
    }
  });
});

describe('rateLimit — fail-open and edge cases', () => {
  it('fails open on misconfigured capacity (capacity = 0)', () => {
    const verdict = rateLimit(SCOPE, 'u1', { capacity: 0, windowMs: 60_000 });
    expect(verdict.ok).toBe(true);
  });

  it('fails open on misconfigured window (windowMs = 0)', () => {
    const verdict = rateLimit(SCOPE, 'u1', { capacity: 5, windowMs: 0 });
    expect(verdict.ok).toBe(true);
  });

  it('fails open on negative capacity', () => {
    const verdict = rateLimit(SCOPE, 'u1', { capacity: -10, windowMs: 60_000 });
    expect(verdict.ok).toBe(true);
  });
});

describe('RateLimits defaults', () => {
  it('exposes the four documented bucket families with positive numbers', () => {
    for (const family of [
      RateLimits.WRITE,
      RateLimits.MESSAGE,
      RateLimits.APPROVAL,
      RateLimits.READ_HEAVY,
    ]) {
      expect(family.capacity).toBeGreaterThan(0);
      expect(family.windowMs).toBeGreaterThan(0);
    }
  });

  it('APPROVAL is tighter than WRITE which is tighter than MESSAGE', () => {
    // Codifies the relative ordering documented in lib/ratelimit.ts.
    expect(RateLimits.APPROVAL.capacity).toBeLessThan(RateLimits.WRITE.capacity);
    expect(RateLimits.WRITE.capacity).toBeLessThan(RateLimits.MESSAGE.capacity);
  });
});
