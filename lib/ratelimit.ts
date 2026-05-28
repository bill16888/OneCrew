/**
 * @file In-process token-bucket rate limiter for the public API surface.
 *
 * The MVP intentionally has zero rate limiting on its write endpoints
 * (audit finding H2). A signed-in user could spam-create messages,
 * tasks, or approval decisions and overwhelm the realtime fan-out, the
 * AI budget, or downstream services. This module fixes that without
 * requiring Redis (already reserved in `docker-compose.prod.yml` for
 * the eventual cluster-wide implementation, but not yet wired).
 *
 * Algorithm: classic token bucket. Each `(scope, key)` pair owns a
 * bucket that holds at most `capacity` tokens and refills at
 * `capacity / windowMs` tokens per millisecond. A request consumes one
 * token; if the bucket has fewer than one token, the request is
 * rejected and the caller is told how long to wait.
 *
 * Operational properties:
 *   - **Per-process state.** Counters are kept in a `Map`, not in
 *     Redis, so each Node instance enforces the limit independently.
 *     A multi-pod deployment effectively multiplies the cap by the pod
 *     count. For the single-process MVP that is the correct trade-off;
 *     migrating to Redis is a one-file change to {@link rateLimit}.
 *   - **Bounded memory.** `sweepIfNeeded` evicts buckets that have
 *     been idle for longer than {@link IDLE_EVICT_MS} every time the
 *     map crosses {@link SWEEP_THRESHOLD} entries. The eviction is
 *     amortised and never blocks a request for more than ~µs.
 *   - **No timers.** The limiter never schedules a `setInterval`, so
 *     it cannot keep the process alive at shutdown.
 *
 * Usage from a Next.js route handler:
 * ```ts
 * import { rateLimit, RateLimits } from '@/lib/ratelimit';
 *
 * const verdict = rateLimit('messages.write', session.user.id, RateLimits.WRITE);
 * if (!verdict.ok) {
 *   return NextResponse.json(
 *     { error: 'Too many requests' },
 *     {
 *       status: 429,
 *       headers: {
 *         'Retry-After': String(Math.ceil(verdict.retryAfterMs / 1000)),
 *       },
 *     },
 *   );
 * }
 * ```
 *
 * Validates: closes audit finding H2 ("zero rate limiting on the
 * entire API surface").
 */

/**
 * Rate-limit configuration for a single bucket family.
 */
export interface RateLimitConfig {
  /** Maximum number of requests permitted in any rolling `windowMs`. */
  readonly capacity: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

/** Result returned by {@link rateLimit}. */
export type RateLimitVerdict =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Standard limits used across the API. Tweak these here rather than at
 * each call site so operations can audit the surface in one place.
 *
 *   - `WRITE`        — broad cap for any write endpoint (tasks,
 *                      ai-colleagues create/patch, channels create).
 *   - `MESSAGE`      — slightly higher cap because chat is the most
 *                      naturally bursty endpoint.
 *   - `APPROVAL`     — tighter cap; approvals are sensitive and a
 *                      runaway click should not bypass review.
 *   - `READ_HEAVY`   — generous cap for GET endpoints that touch the
 *                      DB but do not mutate state.
 */
export const RateLimits = {
  WRITE: { capacity: 30, windowMs: 60_000 } as const,
  MESSAGE: { capacity: 60, windowMs: 60_000 } as const,
  APPROVAL: { capacity: 20, windowMs: 60_000 } as const,
  READ_HEAVY: { capacity: 120, windowMs: 60_000 } as const,
} satisfies Record<string, RateLimitConfig>;

const buckets = new Map<string, Bucket>();

/**
 * Sweep idle buckets after the map crosses this size. Keeps total
 * memory bounded under sustained churn (e.g. each request from a
 * unique IP) without paying eviction cost on every call.
 */
const SWEEP_THRESHOLD = 4096;

/** Drop buckets that have been idle for at least this long (5 min). */
const IDLE_EVICT_MS = 5 * 60_000;

let sweepInProgress = false;

function sweepIfNeeded(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD || sweepInProgress) return;
  sweepInProgress = true;
  try {
    const cutoff = now - IDLE_EVICT_MS;
    for (const [key, bucket] of buckets) {
      if (bucket.updatedAt < cutoff) buckets.delete(key);
    }
  } finally {
    sweepInProgress = false;
  }
}

/**
 * Consume one token from the `(scope, key)` bucket. Returns `{ ok: true,
 * remaining }` when the request is allowed and `{ ok: false,
 * retryAfterMs }` when the bucket is empty.
 *
 * Pass `Date.now()` style timestamps via the optional `nowMs` parameter
 * to make tests deterministic — production callers should omit it.
 *
 * @param scope  Coarse bucket family (e.g. `'messages.write'`).
 *               Distinguishes endpoints with different limits.
 * @param key    Per-caller key (typically `session.user.id`; falls back
 *               to client IP when no session is available).
 * @param config Limit configuration; usually one of {@link RateLimits}.
 * @param nowMs  Optional clock override for deterministic tests.
 */
export function rateLimit(
  scope: string,
  key: string,
  config: RateLimitConfig,
  nowMs: number = Date.now(),
): RateLimitVerdict {
  if (config.capacity <= 0 || config.windowMs <= 0) {
    // A misconfigured limiter must fail open — never block legitimate
    // traffic just because someone wrote `capacity: 0` by mistake.
    return { ok: true, remaining: Number.POSITIVE_INFINITY };
  }

  const bucketKey = `${scope}:${key}`;
  const refillPerMs = config.capacity / config.windowMs;

  let bucket = buckets.get(bucketKey);
  if (bucket === undefined) {
    bucket = { tokens: config.capacity, updatedAt: nowMs };
    buckets.set(bucketKey, bucket);
  } else {
    const elapsedMs = Math.max(0, nowMs - bucket.updatedAt);
    bucket.tokens = Math.min(
      config.capacity,
      bucket.tokens + elapsedMs * refillPerMs,
    );
    bucket.updatedAt = nowMs;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    sweepIfNeeded(nowMs);
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  // Tokens deficit translated into the wait time before a single token
  // is available again. Round up so the client never re-queries before
  // the bucket has actually refilled.
  const tokensNeeded = 1 - bucket.tokens;
  const retryAfterMs = Math.ceil(tokensNeeded / refillPerMs);
  sweepIfNeeded(nowMs);
  return { ok: false, retryAfterMs };
}

/** Test-only escape hatch. Wipes all bucket state; do not call from app code. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}
