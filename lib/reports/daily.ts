/**
 * @file AI daily-report scheduler (Phase 1 Req 15).
 *
 * Schedules a `node-cron` job (default 18:00 in `WORKSPACE_TZ`) that
 * asks every active AI colleague to post an end-of-day digest to
 * `#general`. The report is produced by the SAME `runCycle` path as
 * ordinary AI activity — we only pass an `extraInstruction` (from
 * `lib/reports/prompts.ts`) so all runtime invariants hold: the daily
 * USD budget gate (audit M1), bounded rounds, retry budget, and the
 * `ai:thinking` realtime contract.
 *
 * The custom server (`server.ts`) calls {@link startDailyReportScheduler}
 * after the HTTP server is listening, behind the `DAILY_REPORTS_ENABLED`
 * flag, mirroring the lazy-import pattern used for the backup cron.
 *
 * Manual triggering for a single AI is exposed by
 * `app/api/reports/trigger/route.ts` and shares {@link runReportForAI}.
 *
 * Validates: Phase 1 Req 15.1-15.5.
 */

import cron from 'node-cron';

import { AIRuntime } from '@/lib/ai/runtime';
import { budget } from '@/lib/ai/budget';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { resolveWorkspaceId } from '@/lib/workspace';

import { DAILY_REPORT_INSTRUCTION, DAILY_REPORT_PROMPT_VERSION } from './prompts';

/** Outcome of a single AI's daily-report cycle. */
export interface DailyReportResult {
  readonly aiUserId: string;
  readonly aiName: string;
  readonly status: 'completed' | 'skipped_budget' | 'failed';
}

/**
 * Run the daily-report cycle for one AI colleague.
 *
 * Honours the budget gate (Req 15.3): if `budget.shouldPauseCycle()`
 * is true we skip without issuing any model call, matching the
 * Agentic Loop's own pre-cycle guard. Any failure is caught, logged
 * with `event: 'daily_report_failed'`, and reported back as
 * `status: 'failed'` — the scheduler never throws into cron internals.
 */
export async function runReportForAI(
  aiUserId: string,
  aiName: string,
): Promise<DailyReportResult> {
  if (budget.shouldPauseCycle()) {
    logger.warn(
      { event: 'daily_report_skipped_budget', aiUserId, aiName },
      'Daily report skipped — AI budget paused',
    );
    return { aiUserId, aiName, status: 'skipped_budget' };
  }

  try {
    const result = await AIRuntime.runCycle(aiUserId, {
      extraInstruction: DAILY_REPORT_INSTRUCTION,
    });
    logger.info(
      {
        event: 'daily_report_completed',
        aiUserId,
        aiName,
        promptVersion: DAILY_REPORT_PROMPT_VERSION,
        finishReason: result.finishReason,
        rounds: result.rounds,
      },
      'Daily report cycle finished',
    );
    return { aiUserId, aiName, status: 'completed' };
  } catch (err) {
    // runCycle already converts in-cycle failures to a RunCycleResult;
    // the only throws are config-level (unknown AI). Treat as failed.
    logger.error(
      { event: 'daily_report_failed', aiUserId, aiName, err },
      'Daily report cycle failed',
    );
    return { aiUserId, aiName, status: 'failed' };
  }
}

/**
 * Run the daily report for every active AI colleague in the workspace.
 *
 * AIs are processed sequentially (not in parallel) so a burst of
 * simultaneous model calls cannot spike the budget past the breaker
 * between checks — each `runReportForAI` re-checks `shouldPauseCycle`
 * so once the budget trips mid-batch the remaining AIs are skipped.
 */
export async function runDailyReportOnce(): Promise<DailyReportResult[]> {
  const workspaceId = resolveWorkspaceId();
  const ais = await prisma.user.findMany({
    where: { workspaceId, isAI: true, aiStatus: 'active' },
    select: { id: true, name: true },
  });

  logger.info(
    { event: 'daily_report_batch_start', count: ais.length },
    'Daily report batch starting',
  );

  const results: DailyReportResult[] = [];
  for (const ai of ais) {
    results.push(await runReportForAI(ai.id, ai.name));
  }

  logger.info(
    {
      event: 'daily_report_batch_done',
      completed: results.filter((r) => r.status === 'completed').length,
      skipped: results.filter((r) => r.status === 'skipped_budget').length,
      failed: results.filter((r) => r.status === 'failed').length,
    },
    'Daily report batch finished',
  );
  return results;
}

/** Handle to the scheduled task so callers can stop it on shutdown. */
export interface DailyReportScheduler {
  stop: () => void;
}

/**
 * Schedule the daily-report cron. Returns a handle whose `stop()`
 * detaches the job (used by the server's graceful-shutdown path).
 *
 * No-ops (returns a stub handle + warns) when:
 *   - `DAILY_REPORTS_ENABLED` is false (default), or
 *   - the configured cron expression is invalid.
 *
 * Each scheduled fire wraps {@link runDailyReportOnce} so a thrown
 * error is logged, never propagated into cron internals.
 */
export function startDailyReportScheduler(): DailyReportScheduler {
  if (!env.DAILY_REPORTS_ENABLED) {
    logger.info(
      { event: 'daily_report_disabled' },
      'Daily report scheduler disabled (DAILY_REPORTS_ENABLED=false)',
    );
    return { stop: () => undefined };
  }

  const schedule = env.DAILY_REPORT_CRON;
  if (!cron.validate(schedule)) {
    logger.error(
      { event: 'daily_report_cron_invalid', schedule },
      'Daily report cron expression is invalid; not scheduling',
    );
    return { stop: () => undefined };
  }

  const task = cron.schedule(
    schedule,
    () => {
      void runDailyReportOnce();
    },
    { timezone: env.WORKSPACE_TZ },
  );

  logger.info(
    {
      event: 'daily_report_cron_scheduled',
      schedule,
      timezone: env.WORKSPACE_TZ,
    },
    'Daily report cron scheduled',
  );

  return { stop: () => task.stop() };
}
