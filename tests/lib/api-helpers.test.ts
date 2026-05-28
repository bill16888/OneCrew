/**
 * @file Unit tests for `lib/api-helpers.ts`.
 *
 * Locks the canonical 401 / 429 envelope shape (audit follow-up to
 * PR #1: zero coverage was reported on this 90-line helper). The
 * functions are thin enough that a single happy-path test per code
 * path is sufficient — anything more elaborate belongs in the route
 * handler tests where these helpers are already exercised in context.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/lib/auth/options', () => ({
  authOptions: {},
}));

import { getServerSession } from 'next-auth';

import {
  enforceRateLimit,
  errorResponse,
  requireSession,
} from '@/lib/api-helpers';
import {
  __resetRateLimitsForTests,
  type RateLimitConfig,
} from '@/lib/ratelimit';

const TIGHT: RateLimitConfig = { capacity: 1, windowMs: 60_000 };

describe('errorResponse', () => {
  it('serialises { error: <message> } with the requested status', async () => {
    const res = errorResponse('boom', 418);
    expect(res.status).toBe(418);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'boom' });
  });

  it('preserves caller-supplied headers in the response', async () => {
    const res = errorResponse('boom', 503, {
      headers: { 'Retry-After': '10' },
    });
    expect(res.headers.get('retry-after')).toBe('10');
    expect(res.status).toBe(503);
  });
});

describe('requireSession', () => {
  it('returns the session when getServerSession yields a user with id', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: 'u_test', email: 'a@b.c', name: 'A' },
      expires: '2099-01-01',
    } as never);

    const result = await requireSession();
    expect('user' in result).toBe(true);
    if ('user' in result) {
      expect(result.user.id).toBe('u_test');
    }
  });

  it('returns a 401 NextResponse when no session is present', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null as never);

    const result = await requireSession();
    // NextResponse is the failure path — ensure shape + status.
    expect('json' in result).toBe(true);
    if ('json' in result) {
      expect(result.status).toBe(401);
      const body = (await result.json()) as { error: string };
      expect(body).toEqual({ error: 'Unauthorized' });
    }
  });

  it('returns 401 when session has no user id (token corrupt)', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { email: 'no-id@x' },
      expires: '2099-01-01',
    } as never);

    const result = await requireSession();
    expect('json' in result).toBe(true);
    if ('json' in result) {
      expect(result.status).toBe(401);
    }
  });
});

describe('enforceRateLimit', () => {
  it('returns null when the bucket has tokens', () => {
    __resetRateLimitsForTests();
    const result = enforceRateLimit('test.scope', 'u1', TIGHT);
    expect(result).toBeNull();
  });

  it('returns 429 with Retry-After when the bucket is exhausted', async () => {
    __resetRateLimitsForTests();
    // Burn the only token.
    expect(enforceRateLimit('test.scope', 'u1', TIGHT)).toBeNull();
    const denied = enforceRateLimit('test.scope', 'u1', TIGHT);
    expect(denied).not.toBeNull();
    if (denied) {
      expect(denied.status).toBe(429);
      const retryAfter = denied.headers.get('retry-after');
      expect(retryAfter).not.toBeNull();
      // RateLimit-* exposed for clients per the helper docs.
      expect(denied.headers.get('ratelimit-limit')).toBe(String(TIGHT.capacity));
      expect(denied.headers.get('ratelimit-remaining')).toBe('0');
      const body = (await denied.json()) as { error: string };
      expect(body).toEqual({ error: 'Too many requests' });
    }
  });
});
