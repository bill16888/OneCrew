/**
 * `POST /api/reports/trigger` — manually trigger a daily report for a
 * single AI colleague (Phase 1 Req 15.6).
 *
 * Lets an operator regenerate a report on demand (e.g. from the
 * dashboard AI-status card) without waiting for the 18:00 cron. Runs
 * the same `runReportForAI` code path as the scheduler, so all runtime
 * invariants (budget gate, bounded rounds, thinking broadcast) hold.
 *
 * Contract:
 *   - Method: `POST`
 *   - Auth: requires a valid NextAuth session.
 *   - Rate limit: per-AI write bucket keyed `daily-report:{aiUserId}`
 *     (Req 15.6) so a runaway client can't spam report cycles.
 *   - Body: `{ aiUserId: string }`
 *   - Responses:
 *     - `200 { status }` — 'completed' | 'skipped_budget' | 'failed'.
 *     - `400 { error }` malformed body / unknown or non-AI user.
 *     - `401 { error }` no session.
 *     - `404 { error }` AI not found in the workspace.
 *     - `429 { error }` per-AI bucket exhausted.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  enforceRateLimit,
  errorResponse,
  requireSession,
  type ApiErrorResponse,
} from '@/lib/api-helpers';
import prisma from '@/lib/prisma';
import { RateLimits } from '@/lib/ratelimit';
import { runReportForAI } from '@/lib/reports/daily';
import { resolveWorkspaceId } from '@/lib/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TRIGGER_BODY = z.object({
  aiUserId: z.string().min(1).max(100),
});

interface TriggerResponse {
  status: 'completed' | 'skipped_budget' | 'failed';
}

export async function POST(
  request: Request,
): Promise<NextResponse<TriggerResponse | ApiErrorResponse>> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400);
  }
  const parsed = TRIGGER_BODY.safeParse(body);
  if (!parsed.success) {
    return errorResponse('Field "aiUserId" must be a non-empty string.', 400);
  }
  const { aiUserId } = parsed.data;

  // Per-AI rate limit (Req 15.6): tighter than a generic write bucket
  // because each trigger spends model tokens.
  const limited = enforceRateLimit(
    `daily-report:${aiUserId}`,
    session.user.id,
    RateLimits.APPROVAL,
  );
  if (limited) return limited;

  // Verify the target is an active AI in this workspace before spending
  // any tokens.
  const ai = await prisma.user.findFirst({
    where: { id: aiUserId, workspaceId: resolveWorkspaceId(), isAI: true },
    select: { id: true, name: true },
  });
  if (!ai) {
    return errorResponse('AI colleague not found in this workspace.', 404);
  }

  const result = await runReportForAI(ai.id, ai.name);
  return NextResponse.json<TriggerResponse>(
    { status: result.status },
    { status: 200 },
  );
}
