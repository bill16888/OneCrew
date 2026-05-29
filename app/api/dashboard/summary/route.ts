/**
 * `GET /api/dashboard/summary` — consolidated data for the operator
 * dashboard's four panels (Phase 1 Req 13).
 *
 * Used by the dashboard's client-side refresh; the server-rendered
 * first paint calls `DashboardService.getDashboardSummary` directly.
 *
 * Contract:
 *   - Method: `GET`
 *   - Auth: requires a valid NextAuth session (middleware enforces the
 *     401 for unauthenticated `/api/*`, audit H3).
 *   - Rate limit: `RateLimits.READ_HEAVY` per user (Req 13.5).
 *   - Response: {@link DashboardSummary}.
 */

import { NextResponse } from 'next/server';

import {
  enforceRateLimit,
  errorResponse,
  requireSession,
  type ApiErrorResponse,
} from '@/lib/api-helpers';
import { RateLimits } from '@/lib/ratelimit';
import {
  DashboardService,
  type DashboardSummary,
} from '@/lib/services/dashboard.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<
  NextResponse<DashboardSummary | ApiErrorResponse>
> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const limited = enforceRateLimit(
    'dashboard.summary',
    session.user.id,
    RateLimits.READ_HEAVY,
  );
  if (limited) return limited;

  try {
    const summary = await DashboardService.getDashboardSummary();
    return NextResponse.json<DashboardSummary>(summary, { status: 200 });
  } catch {
    return errorResponse('Failed to load dashboard summary.', 500);
  }
}
