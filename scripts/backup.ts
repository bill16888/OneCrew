/**
 * @file Database backup — `pg_dump | gzip → S3-compatible bucket`.
 *
 * Two surfaces:
 *
 * 1. A reusable {@link runBackup} function that performs the full
 *    pipeline once. The Agentic-Loop process re-uses this from
 *    `scripts/backup-cron.ts` so the in-process scheduler does not
 *    spawn a separate Node runtime for every nightly run.
 *
 * 2. A CLI entry point. When this file is executed directly via
 *    `npm run db:backup` (`tsx scripts/backup.ts`) it invokes
 *    {@link runBackup} once and exits with code 0 / 1.
 *
 * Pipeline:
 *
 *   pg_dump $DATABASE_URL | gzip > /tmp/backup-<UTC>.sql.gz
 *   PutObjectCommand → s3://$BACKUP_BUCKET_NAME/...
 *   fs.unlink(local file)
 *
 * Configuration (read from `process.env` lazily so the cron can run
 * even when these are unset — see `isBackupConfigured()`):
 *
 *   DATABASE_URL              — required by pg_dump.
 *   BACKUP_STORAGE_URL        — S3 / R2 endpoint (e.g.
 *                                https://<accountid>.r2.cloudflarestorage.com).
 *   BACKUP_BUCKET_NAME        — destination bucket.
 *   BACKUP_ACCESS_KEY_ID      — S3 access key id.
 *   BACKUP_SECRET_ACCESS_KEY  — S3 secret access key.
 *   BACKUP_REGION             — optional, defaults to `'auto'` for R2.
 *
 * Validates: Operational concerns (P1 task #2 — automated backups).
 */

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Env keys we need for a successful backup. */
const REQUIRED_ENV_KEYS = [
  'DATABASE_URL',
  'BACKUP_STORAGE_URL',
  'BACKUP_BUCKET_NAME',
  'BACKUP_ACCESS_KEY_ID',
  'BACKUP_SECRET_ACCESS_KEY',
] as const;

/**
 * Resolved configuration for one backup run. The cron entry point
 * (`scripts/backup-cron.ts`) calls {@link isBackupConfigured} *before*
 * scheduling so a missing var is reported once with a `warn` instead of
 * exploding nightly.
 */
export interface BackupConfig {
  readonly databaseUrl: string;
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

/**
 * Read backup-related env vars and verify all required ones are
 * populated. Returns the resolved {@link BackupConfig} or a list of
 * missing keys.
 */
export function loadBackupConfig():
  | { ok: true; config: BackupConfig }
  | { ok: false; missing: string[] } {
  const missing: string[] = [];
  for (const key of REQUIRED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value !== 'string' || value.length === 0) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    config: {
      databaseUrl: process.env.DATABASE_URL as string,
      endpoint: process.env.BACKUP_STORAGE_URL as string,
      bucket: process.env.BACKUP_BUCKET_NAME as string,
      accessKeyId: process.env.BACKUP_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.BACKUP_SECRET_ACCESS_KEY as string,
      // `'auto'` matches Cloudflare R2's region-less convention; AWS
      // S3 callers can override via `BACKUP_REGION`.
      region: process.env.BACKUP_REGION ?? 'auto',
    },
  };
}

/**
 * Lightweight predicate used by the cron module before scheduling so a
 * misconfigured environment fails warn-and-skip instead of crash-loop.
 */
export function isBackupConfigured(): boolean {
  return loadBackupConfig().ok;
}

/**
 * Build the timestamped object key. Format: `backup-YYYY-MM-DD-HHmmss.sql.gz`
 * using UTC components so two regions never disagree on the filename.
 */
function buildBackupFilename(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const yyyy = pad(now.getUTCFullYear(), 4);
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `backup-${yyyy}-${mm}-${dd}-${hh}${mi}${ss}.sql.gz`;
}

/**
 * Spawn `pg_dump`, pipe its stdout into a gzip stream, and write the
 * result to `outPath`. Resolves on a clean exit (code 0); rejects with
 * a descriptive error otherwise.
 *
 * `pg_dump` reads its connection from the `--dbname` flag instead of
 * the env so we do not leak `DATABASE_URL` through inheritance to any
 * child of this process.
 */
async function runPgDumpToFile(
  databaseUrl: string,
  outPath: string,
): Promise<void> {
  const child = spawn(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=plain', `--dbname=${databaseUrl}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Surface pg_dump diagnostics so backup failures are debuggable.
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const out = createWriteStream(outPath);
  const gzip = createGzip();

  // `pipeline()` waits for all three streams to finish/error and
  // propagates the first failure as a single rejection.
  const pipelinePromise = pipeline(child.stdout, gzip, out);

  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `pg_dump exited with code=${code} signal=${signal ?? 'none'}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });

  await Promise.all([pipelinePromise, exitPromise]);
}

/**
 * Upload a local file to the configured bucket. The S3 client is
 * constructed per-call so a long-running cron does not hold a stale
 * client across rotations of credentials.
 */
async function uploadToBucket(
  config: BackupConfig,
  localPath: string,
  objectKey: string,
): Promise<void> {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // R2 / MinIO compatibility: virtual-hosted addressing requires DNS
    // entries we can't guarantee exist for the bucket, so default to
    // path style for portability.
    forcePathStyle: true,
  });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        Body: createReadStream(localPath),
        ContentType: 'application/gzip',
      }),
    );
  } finally {
    client.destroy();
  }
}

/** Result returned by a successful backup run. */
export interface BackupRunResult {
  readonly filename: string;
  /** Size of the gzipped dump in bytes. */
  readonly sizeBytes: number;
}

/**
 * Run the full backup pipeline once: dump, upload, clean up.
 *
 * The function reads its configuration via {@link loadBackupConfig}.
 * When configuration is incomplete it throws with a list of missing
 * keys so callers can decide whether to crash (CLI) or log-and-skip
 * (cron).
 */
export async function runBackup(now: Date = new Date()): Promise<BackupRunResult> {
  const cfg = loadBackupConfig();
  if (!cfg.ok) {
    throw new Error(
      `Missing backup env vars: ${cfg.missing.join(', ')}`,
    );
  }

  const filename = buildBackupFilename(now);
  const localPath = join(tmpdir(), filename);

  try {
    await runPgDumpToFile(cfg.config.databaseUrl, localPath);
    const { size } = statSync(localPath);
    await uploadToBucket(cfg.config, localPath, filename);
    return { filename, sizeBytes: size };
  } finally {
    // Always try to clean up the temp file, even on failure paths, so
    // a partial dump does not pile up under /tmp on long-running
    // containers. Swallow ENOENT — the dump may have failed before
    // creating the file at all.
    try {
      await unlink(localPath);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Detect whether this module is the entry point of the current Node
 * invocation. Works under both `tsx` and the future post-`tsc` build
 * because we compare resolved paths instead of `require.main` (which
 * doesn't exist in ESM contexts).
 */
function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // Cheap suffix check rather than dynamic ESM `import.meta.url` URL
  // parsing — it's robust enough for the single CLI entry we ship.
  return argv1.endsWith('backup.ts') || argv1.endsWith('backup.js');
}

if (isCliEntry()) {
  runBackup()
    .then(({ filename, sizeBytes }) => {
      const sizeKb = Math.round(sizeBytes / 1024);
      // eslint-disable-next-line no-console
      console.log(`Backup completed: ${filename} (${sizeKb}KB)`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Backup failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
