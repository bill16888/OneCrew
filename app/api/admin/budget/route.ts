/**
 * `GET /api/admin/budget` — internal AI budget snapshot.
 *
 * Returns the current state of the daily AI token-spend tracker
 * (`lib/ai/budget.ts`) so dashboards and on-call humans can spot a
 * runaway cost trajectory before the circuit breaker trips.
 *
 * Contract:
 *   - Method: `GET`
 *   - Auth: requires a valid NextAuth session. The middleware in
 *     `middleware.ts` enforces this for every `/api/*` path that is
 *     not explicitly excluded; for API callers the response is a
 *     JSON `401 { error: 'Unauthorized' }` (audit finding H3).
 *   - Response shape:
 *     ```json
 *     {
 *       "todayUSD": number,    // accumulated USD since the last UTC midnight
 *       "limitUSD": number,    // env.AI_DAILY_BUDGET_USD
 *       "resetAt":  string,    // ISO 8601 — next UTC midnight
 *       "pctUsed":  number     // 0..100 — capped to 100 even when the breaker tripped
 *     }
 *     ```
 *
 * Hardening note:
 *   The endpoint exposes only aggregate numeric counters — no PII, no
 *   per-user accounting — but a public GET would still let an attacker
 *   probe the budget remaining and time abuse around the UTC reset.
 *   Today the session check is the first gate; if the surface ever
 *   needs a service-to-service caller (e.g. a Prometheus exporter),
 *   add a Bearer-token check in addition to the session, never in
 *   place of it.
 *
 * Validates: Operational concerns (P0 fix #3 — budget visibility);
 *            audit finding H3.
 */

import { NextResponse } from 'next/server';

import { budget } from '@/lib/ai/budget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BudgetResponse {
  todayUSD: number;
  limitUSD: number;
  resetAt: string;
  pctUsed: number;
}

/**
 * Compute `pctUsed` as `100 * todayUSD / limitUSD`, clamped to the
 * inclusive range `[0, 100]`. When `limitUSD` is `0` we report `0` to
 * avoid `Infinity` in the response (a zero limit means budgeting is
 * effectively disabled, not "infinitely over"). The cap at 100 keeps
 * downstream UI gauges from rendering nonsensical 110%+ states when
 * the breaker has already tripped (audit nit L4).
 */
function computePctUsed(todayUSD: number, limitUSD: number): number {
  if (!Number.isFinite(limitUSD) || limitUSD <= 0) return 0;
  const pct = (todayUSD / limitUSD) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/** Handle `GET /api/admin/budget`. */
export function GET(): NextResponse<BudgetResponse> {
  const stats = budget.getStats();
  const body: BudgetResponse = {
    todayUSD: stats.todayUSD,
    limitUSD: stats.limitUSD,
    resetAt: stats.resetAt.toISOString(),
    pctUsed: computePctUsed(stats.todayUSD, stats.limitUSD),
  };
  return NextResponse.json<BudgetResponse>(body, { status: 200 });
}
