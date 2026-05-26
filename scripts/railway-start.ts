import { spawn } from 'node:child_process';

const DB_URL_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
] as const;

function nonEmptyEnv(key: string): string | undefined {
  const value = process.env[key];
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
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

  console.log('==> running prisma db push');
  await run('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate']);

  console.log('==> starting server.ts via tsx');
  await run('node_modules/.bin/tsx', ['server.ts']);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
