/**
 * @file Helpers shared by Next.js App Router API route handlers.
 *
 * The route layer historically inlined session lookups, error envelope
 * shapes, and rate-limit checks at every endpoint. This module folds
 * those duplicates into a small set of functions:
 *
 *   - {@link requireSession} — return either the resolved session or
 *     a JSON 401 response, never throw.
 *   - {@link enforceRateLimit} — consume one token from the named
 *     bucket and either return `null` (allowed) or a JSON 429 response
 *     with a `Retry-After` header (denied).
 *   - {@link errorResponse} — build the canonical `{ error }` envelope
 *     with the appropriate status code.
 *
 * Validates: closes audit findings H2 (rate limiting on every write
 * endpoint) and H3 (`/api` returns JSON 401 instead of redirecting to
 * `/login`, which is meaningless for API clients).
 */

import { getServerSession, type Session } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '@/lib/auth/options';
import { rateLimit, type RateLimitConfig } from '@/lib/ratelimit';

export interface ApiErrorResponse {
  error: string;
}

export function errorResponse(
  message: string,
  status: number,
  init?: ResponseInit,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json<ApiErrorResponse>(
    { error: message },
    { ...init, status },
  );
}

/**
 * Resolve the active NextAuth session and assert that the caller is
 * signed in. On success returns the session (with `user.id` guaranteed
 * to be a non-empty string). On failure returns a JSON 401 response
 * the caller can short-circuit on:
 *
 * ```ts
 * const session = await requireSession();
 * if (session instanceof NextResponse) return session;
 * // session.user.id is now safely typed as `string`
 * ```
 */
export async function requireSession(): Promise<
  | (Session & { user: { id: string } })
  | NextResponse<ApiErrorResponse>
> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return errorResponse('Unauthorized', 401);
  }
  return session as Session & { user: { id: string } };
}

/**
 * Consume one token from a per-user rate-limit bucket. Returns `null`
 * when the request is allowed, or a 429 JSON response (with
 * `Retry-After` and `RateLimit-*` headers) when the caller has
 * exceeded the cap.
 *
 * Most write endpoints can use this directly; read endpoints typically
 * skip it.
 *
 * @param scope   Bucket family identifying the endpoint (e.g.
 *                `'messages.write'`).
 * @param userId  Caller user id. Falls back to a coarse `'anon'` key
 *                if your endpoint allows anonymous writes (it does
 *                not, in the current MVP).
 * @param config  Limit settings — usually one of `RateLimits.*`.
 */
export function enforceRateLimit(
  scope: string,
  userId: string,
  config: RateLimitConfig,
): NextResponse<ApiErrorResponse> | null {
  const verdict = rateLimit(scope, userId, config);
  if (verdict.ok) return null;
  const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  return errorResponse('Too many requests', 429, {
    headers: {
      'Retry-After': String(retryAfterSec),
      'RateLimit-Limit': String(config.capacity),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': String(retryAfterSec),
    },
  });
}
