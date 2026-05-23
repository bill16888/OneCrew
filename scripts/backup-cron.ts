/**
 * @file Daily database backup scheduler.
 *
 * The custom server (`server.ts`) dynamically imports this module after
 * the HTTP server is listening; importing it has the side effect of
 * scheduling a `node-cron` job that runs at **02:00 UTC every day**
 * (`0 2 * * *`). The job calls {@link runBackup} from `scripts/backup.ts`
 * directly — no child-process spawning — so the scheduler shares the
 * same Node runtime, env, and logger as the rest of the app.
 *
 * Behaviour when storage env vars are missing:
 *
 *   The four `BACKUP_*` variables (and `DATABASE_URL`) are NOT validated
 *   by `lib/env.ts` because backup is an optional capability. Instead,
 *   this module probes them at boot via {@link isBackupConfigured} and:
 *
 *     - logs a single `warn` and **skips scheduling** if anything is
 *       missing — the main service stays up, no nightly crashes;
 *     - schedules the cron normally otherwise.
 *
 *   Each scheduled run additionally guards itself with a try/catch so a
 *   transient `pg_dump` or S3 failure is logged and forgotten instead of
 *   propagating into the cron internals.
 *
 * Validates: Operational concerns (P1 task #2 — daily backup at 02:00 UTC).
 */

import cron from 'node-cron';

import { logger } from '@/lib/logger';

import { isBackupConfigured, loadBackupConfig, runBackup } from './backup';

/** Crontab expression: 02:00 UTC every day. */
const SCHEDULE = '0 2 * * *';

/**
 * Run one backup cycle and log the outcome. Wraps {@link runBackup} so
 * thrown errors never escape into the cron scheduler.
 */
async function runOnce(): Promise<void> {
  const start = Date.now();
  try {
    const result = await runBackup();
    logger.info(
      {
        event: 'backup_completed',
        filename: result.filename,
        sizeBytes: result.sizeBytes,
        durationMs: Date.now() - start,
      },
      'Database backup completed',
    );
  } catch (err) {
    logger.error(
      { event: 'backup_failed', err, durationMs: Date.now() - start },
      'Database backup failed',
    );
  }
}

// Module side-effect: schedule (or warn-and-skip) at import time.
const cfg = loadBackupConfig();
if (!cfg.ok) {
  logger.warn(
    { event: 'backup_cron_skipped', missing: cfg.missing },
    'Backup cron skipped — required env vars are not set',
  );
} else if (!cron.validate(SCHEDULE)) {
  // Defensive: SCHEDULE is a static literal, but if a future edit
  // introduces a typo we want a loud failure during boot rather than
  // a silent no-op.
  logger.error(
    { event: 'backup_cron_invalid', schedule: SCHEDULE },
    'Backup cron schedule is invalid; not scheduling',
  );
} else {
  cron.schedule(
    SCHEDULE,
    () => {
      // node-cron expects either a sync callback or one that returns a
      // promise; we wrap with `void` so the typed signature stays sync.
      void runOnce();
    },
    { timezone: 'UTC' },
  );
  logger.info(
    {
      event: 'backup_cron_scheduled',
      schedule: SCHEDULE,
      bucket: cfg.config.bucket,
    },
    'Backup cron scheduled',
  );
}

/** Re-export so tests / manual invocations can drive the same logic. */
export { runOnce };
