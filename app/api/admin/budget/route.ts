/**
 * `GET /api/admin/budget` — internal AI budget snapshot.
 *
 * Returns the current state of the daily AI token-spend tracker
 * (`lib/ai/budget.ts`) so dashboards and on-call humans can spot a
 * runaway cost trajectory before the circuit breaker trips.
 *
 * Contract:
 *   - Method: `GET`
 *   - Auth: **none** (intentional — see security note below).
 *   - Response shape:
 *     ```json
 *     {
 *       "todayUSD": number,    // accumulated USD since the last UTC midnight
 *       "limitUSD": number,    // env.AI_DAILY_BUDGET_USD
 *       "resetAt":  string,    // ISO 8601 — next UTC midnight
 *       "pctUsed":  number     // 0..100+ (>100 means the breaker tripped)
 *     }
 *     ```
 *
 * Security note:
 *   The brief explicitly calls out that this endpoint is internal-only
 *   and does not require auth. In production it MUST be reached only
 *   from inside the cluster (compose network, VPN, or a network policy
 *   that blocks it from public ingress). It returns no PII and only
 *   numeric counters, but exposing it publicly would still let an
 *   attacker probe the budget remaining and time abuse around the UTC
 *   reset window, so the network-level gate is non-optional.
 *
 * Validates: Operational concerns (P0 fix #3 — budget visibility).
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
 * Compute `pctUsed` as `100 * todayUSD / limitUSD`, clamped to a
 * non-negative finite number. When `limitUSD` is `0` we report `0` to
 * avoid `Infinity` in the response (a zero limit means budgeting is
 * effectively disabled, not "infinitely over").
 */
function computePctUsed(todayUSD: number, limitUSD: number): number {
  if (!Number.isFinite(limitUSD) || limitUSD <= 0) return 0;
  const pct = (todayUSD / limitUSD) * 100;
  return Number.isFinite(pct) ? Math.max(0, pct) : 0;
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
