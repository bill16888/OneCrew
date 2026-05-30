/**
 * @file Production entrypoint executed by `tini` inside the Docker
 * container (and by Railway directly).
 *
 * Responsibilities, in order:
 *
 *   1. Normalise Railway/Heroku-style Postgres env vars into the single
 *      `DATABASE_URL` Prisma expects.
 *   2. Apply pending Prisma schema changes against the live database.
 *      The default strategy is `prisma migrate deploy` (audited, version-
 *      controlled migration history). For brand-new bootstraps the
 *      `PRISMA_DEPLOY_STRATEGY=push` escape hatch is still available to
 *      run `db push --accept-data-loss` instead — useful only for the
 *      first deploy of a greenfield environment.
 *      Recovery escape hatches (set on the service for ONE deploy, then
 *      unset): `PRISMA_BASELINE_MIGRATIONS` for P3005 (non-empty DB,
 *      empty history); and for P3009 (a migration recorded as failed)
 *      either `PRISMA_RESET_FAILED_MIGRATIONS=true` (drops + re-applies
 *      everything — safe only when there is no real data) or
 *      `PRISMA_RESOLVE_ROLLED_BACK=<name|auto>` (marks the failed
 *      migration rolled back and retries).
 *   3. Boot the custom `server.ts` via `tsx`, which wires up Next.js +
 *      Socket.io + the Agentic Loop in a single process.
 *
 * The wrapper exits non-zero on any failure so the container restarts
 * and the orchestrator surfaces a clear "crash loop" signal instead of
 * silently coming up half-broken.
 */

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DB_URL_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
] as const;

const MIGRATIONS_DIR = 'prisma/migrations';

function nonEmptyEnv(key: string): string | undefined {
  const value = process.env[key];
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a boolean-ish env var. Accepts the common truthy spellings so
 * an operator does not have to remember exact casing.
 */
function boolEnv(key: string): boolean {
  const value = nonEmptyEnv(key)?.toLowerCase();
  return value !== undefined && ['1', 'true', 'on', 'yes'].includes(value);
}

/**
 * Best-effort extraction of the failed migration's directory name from
 * a Prisma `P3009` error message, e.g.
 *   "The `0_init` migration started at ... failed"
 * Returns `undefined` when no name can be parsed (the caller then
 * requires an explicit name instead of guessing).
 */
function parseFailedMigrationName(output: string): string | undefined {
  const patterns = [
    /[`'"]([A-Za-z0-9_.-]+)[`'"]\s+migration\b/, // `0_init` migration ...
    /\bmigration\s+[`'"]([A-Za-z0-9_.-]+)[`'"]/, // migration `0_init` ...
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function encodeConnectionPart(value: string): string {
  return encodeURIComponent(value);
}

function resolveDatabaseUrl(): string | undefined {
  for (const key of DB_URL_KEYS) {
    const value = nonEmptyEnv(key);
    if (value) return value;
  }

  const host = nonEmptyEnv('PGHOST');
  const port = nonEmptyEnv('PGPORT') ?? '5432';
  const user = nonEmptyEnv('PGUSER');
  const password = nonEmptyEnv('PGPASSWORD');
  const database = nonEmptyEnv('PGDATABASE');

  if (!host || !user || !password || !database) return undefined;

  return `postgresql://${encodeConnectionPart(user)}:${encodeConnectionPart(
    password,
  )}@${host}:${port}/${encodeConnectionPart(database)}?schema=public`;
}

function normaliseEnv(): void {
  const databaseUrl = resolveDatabaseUrl();
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
  }

  if (process.env.NEXT_PUBLIC_SOCKET_URL?.trim().length === 0) {
    delete process.env.NEXT_PUBLIC_SOCKET_URL;
  }
}

interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a child process inheriting parent stdio and resolve whether or
 * not it exited with a zero status. Throws only on `spawn` failures
 * (e.g. ENOENT) so callers can branch on the exit code without nesting
 * try/catch.
 */
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${signal ?? code ?? 'unknown status'}`,
        ),
      );
    });
  });
}

/**
 * Like {@link run}, but captures stdout/stderr as strings so callers
 * can inspect Prisma error codes (e.g. `P3005`). Resolves with the
 * combined result regardless of exit status — never rejects on a
 * non-zero exit, only on `spawn` failures.
 */
function runCapturing(
  command: string,
  args: readonly string[],
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code: code ?? -1, signal, stdout, stderr });
    });
  });
}

function listMigrationDirs(): string[] {
  try {
    return readdirSync(MIGRATIONS_DIR)
      .filter((entry) => {
        try {
          return statSync(join(MIGRATIONS_DIR, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Apply pending schema changes.
 *
 * - When `PRISMA_DEPLOY_STRATEGY=push`, fall back to the legacy
 *   `db push --accept-data-loss` path. This is unsafe for any DB
 *   that holds real data (it can drop columns/tables silently) and
 *   should only be used for greenfield bootstraps.
 * - Otherwise run `prisma migrate deploy`. If the database is non-
 *   empty but has no migration history yet (Prisma error `P3005`,
 *   typical of a DB previously managed by `db push`), check whether
 *   the operator has explicitly opted in to baselining via
 *   `PRISMA_BASELINE_MIGRATIONS=<comma-separated names>`. If so, mark
 *   ONLY those migrations as already-applied and retry. The earlier
 *   "auto-baseline every directory" behaviour silently swallowed any
 *   newer migration shipped at the same time, leading to a schema
 *   drift that is hard to detect at 3 a.m. (audit follow-up to PR #1).
 */
async function applySchema(): Promise<void> {
  const strategy = (nonEmptyEnv('PRISMA_DEPLOY_STRATEGY') ?? 'migrate').toLowerCase();

  if (strategy === 'push') {
    console.warn(
      '==> PRISMA_DEPLOY_STRATEGY=push: using `db push --accept-data-loss` (data may be lost on schema changes)',
    );
    await run('npx', [
      'prisma',
      'db',
      'push',
      '--accept-data-loss',
      '--skip-generate',
    ]);
    return;
  }

  console.log('==> running prisma migrate deploy');
  const result = await runCapturing('npx', ['prisma', 'migrate', 'deploy']);
  if (result.code === 0) return;

  const combined = `${result.stdout}\n${result.stderr}`;

  // P3005: "The database schema is not empty" — typical of a DB
  // previously managed by `db push`. We refuse to silently mark every
  // local migration as applied because that path will skip a real
  // schema-changing migration shipped at the same time as the cutover.
  // Operators must explicitly list the migrations they know are
  // already applied via `PRISMA_BASELINE_MIGRATIONS`.
  if (combined.includes('P3005')) {
    const baselineEnv = nonEmptyEnv('PRISMA_BASELINE_MIGRATIONS');
    if (!baselineEnv) {
      throw new Error(
        [
          'prisma migrate deploy returned P3005 (database schema is not empty,',
          'but the migration history is also empty). This deployment was probably',
          'managed by `db push` previously. To recover, set',
          '`PRISMA_BASELINE_MIGRATIONS=<comma-separated migration directory names',
          'whose schema is ALREADY in the database>` for ONE deploy, then unset.',
          'Check `prisma/migrations/` for the directory names. Listing migrations',
          'that have NOT actually been applied will mark them applied without',
          'running them, leading to silent schema drift — only list ones already',
          'reflected in the live schema.',
        ].join(' '),
      );
    }

    const requested = baselineEnv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const known = new Set(listMigrationDirs());
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `PRISMA_BASELINE_MIGRATIONS contains unknown migration directory names: ${unknown.join(', ')}. ` +
          `Known directories: ${[...known].join(', ') || '(none)'}.`,
      );
    }

    console.warn(
      `==> baselining ${requested.length} explicitly-listed migration(s): ${requested.join(', ')}`,
    );
    for (const name of requested) {
      await run('npx', ['prisma', 'migrate', 'resolve', '--applied', name]);
    }
    console.log('==> retrying prisma migrate deploy after baselining');
    await run('npx', ['prisma', 'migrate', 'deploy']);
    return;
  }

  // P3009: the target database has a migration recorded as FAILED (it
  // started but never finished), so Prisma refuses to apply anything
  // until the history is repaired. This commonly happens when the very
  // first migration was interrupted, or ran against a database that
  // already had some objects. There is no safe one-size auto-fix, so we
  // expose two explicit, operator-opted-in recovery paths and otherwise
  // fail with precise instructions.
  if (combined.includes('P3009')) {
    const failedName = parseFailedMigrationName(combined);

    // (a) DESTRUCTIVE reset — the right choice when the failed migration
    //     is early (e.g. 0_init) and the database holds no real data yet.
    //     Drops everything and re-applies every migration cleanly, so the
    //     history ends up consistent. Gated behind an explicit env var
    //     and a loud warning, mirroring the `db push --accept-data-loss`
    //     escape hatch above.
    if (boolEnv('PRISMA_RESET_FAILED_MIGRATIONS')) {
      console.warn(
        '==> P3009 + PRISMA_RESET_FAILED_MIGRATIONS=true: running ' +
          '`prisma migrate reset --force --skip-seed`. THIS DROPS ALL DATA ' +
          'in the target database and re-applies migrations from scratch. ' +
          'Unset this variable after the deploy succeeds.',
      );
      await run('npx', [
        'prisma',
        'migrate',
        'reset',
        '--force',
        '--skip-seed',
      ]);
      return;
    }

    // (b) NON-DESTRUCTIVE roll-back — the right choice when the failed
    //     migration left NO partial objects behind (so re-applying it
    //     will succeed). Marks it rolled back and retries deploy. Set
    //     PRISMA_RESOLVE_ROLLED_BACK to the migration directory name, or
    //     `auto` to use the name parsed from the P3009 message.
    const resolveTarget = nonEmptyEnv('PRISMA_RESOLVE_ROLLED_BACK');
    if (resolveTarget) {
      const name = resolveTarget === 'auto' ? failedName : resolveTarget;
      if (!name) {
        throw new Error(
          'PRISMA_RESOLVE_ROLLED_BACK=auto, but the failed migration name ' +
            'could not be parsed from the P3009 output. Set it to the ' +
            'explicit migration directory name instead (see prisma/migrations/).',
        );
      }
      console.warn(
        `==> P3009: marking failed migration '${name}' as rolled back, then retrying deploy. ` +
          'If the retry fails with "already exists", the migration left partial ' +
          'objects — use PRISMA_RESET_FAILED_MIGRATIONS=true (drops data) instead.',
      );
      await run('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', name]);
      console.log('==> retrying prisma migrate deploy after roll-back');
      await run('npx', ['prisma', 'migrate', 'deploy']);
      return;
    }

    throw new Error(
      [
        `prisma migrate deploy failed with P3009: a previous migration` +
          (failedName ? ` (\`${failedName}\`)` : '') +
          ` is recorded as FAILED in the database, blocking all new migrations.`,
        'Pick ONE recovery path (set the variable on the Railway service, redeploy, then unset it):',
        '• If this database has NO real data yet (e.g. the first migration never',
        '  finished): set PRISMA_RESET_FAILED_MIGRATIONS=true to drop + re-apply',
        '  everything cleanly.',
        '• If the failed migration left nothing behind and you want to keep data:',
        `  set PRISMA_RESOLVE_ROLLED_BACK=${failedName ?? '<migration-name>'} (or =auto)`,
        '  to mark it rolled back and retry.',
        '• Quick bootstrap without touching history: PRISMA_DEPLOY_STRATEGY=push',
        '  (runs db push --accept-data-loss; leaves the failed row, so prefer the',
        '  options above for a clean migration history).',
      ].join(' '),
    );
  }

  throw new Error(
    `prisma migrate deploy failed (exit ${result.code}). See logs above. ` +
      `If this is a fresh greenfield environment, set PRISMA_DEPLOY_STRATEGY=push for the first boot.`,
  );
}

async function main(): Promise<void> {
  normaliseEnv();

  if (!process.env.DATABASE_URL) {
    throw new Error(
      [
        'DATABASE_URL is missing.',
        'In Railway, set the app service variable DATABASE_URL to `${{Postgres.DATABASE_URL}}`',
        'or provide PGHOST, PGPORT, PGUSER, PGPASSWORD, and PGDATABASE.',
      ].join(' '),
    );
  }

  await applySchema();

  console.log('==> starting server.ts via tsx');
  await run('node_modules/.bin/tsx', ['server.ts']);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
