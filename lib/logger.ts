/**
 * @file Process-wide structured logger built on top of `pino`.
 *
 * One singleton {@link Logger} instance is shared across every server-side
 * module: the AI runtime (`lib/ai/runtime.ts`), the Agentic Loop
 * (`lib/loop/agentic-loop.ts`, landing in task 10.x), and the service
 * layer. Going through a single emitter keeps log output uniform and
 * lets us swap transports (pino-pretty for humans, raw NDJSON for log
 * aggregators) from a single switch.
 *
 * Behavior summary:
 *
 * - **Level** is read from `process.env.LOG_LEVEL` and defaults to
 *   `'info'`. Values follow pino's standard hierarchy
 *   (`fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`).
 * - **Transport**: in any non-production `NODE_ENV` we pipe through
 *   `pino-pretty` for colourised, human-friendly output during `npm run
 *   dev`. In production (`NODE_ENV === 'production'`) we leave the
 *   transport unset so pino emits the raw NDJSON stream that log
 *   aggregators expect.
 * - **Singleton via `globalThis`**: Next.js development mode hot-reloads
 *   modules on every file change. Without caching, each reload would
 *   spawn a fresh logger (and, with pino-pretty, a fresh worker thread)
 *   and orphan any in-flight log writes. We stash one instance on
 *   `globalThis.__logger__` so HMR reuses it, mirroring the pattern in
 *   `lib/prisma.ts` and `lib/loop/emitter.ts`.
 *
 * Reference: design.md → "Error Handling" / "AI Runtime"; Requirement
 * 10.5 ("记录每个 AI 决策周期的开始时间、结束时间、轮数与最终结果摘要").
 *
 * @example
 * ```ts
 * import { logger } from '@/lib/logger';
 *
 * // Structured info log — first arg is a fields object, second is msg.
 * logger.info({ event: 'ai_cycle_finished', aiUserId, rounds }, 'cycle done');
 *
 * // Errors carry the original exception under the conventional `err` key
 * // so pino's serializer prints stack + message.
 * logger.error({ event: 'ai_cycle_error', aiUserId, err }, 'AI cycle failed');
 * ```
 */

import pino, { type Logger, type LoggerOptions } from 'pino';

import { env } from './env';

/**
 * Shape of the Node global with our cached logger attached. Using a
 * dedicated, namespaced key keeps the singleton fully typed without
 * leaking `any` into call sites or polluting `globalThis` typings.
 */
type GlobalWithLogger = typeof globalThis & {
  __logger__?: Logger;
};

const globalForLogger = globalThis as GlobalWithLogger;

/**
 * Whether the current Node process is running in production mode.
 *
 * We treat any value other than the literal string `'production'` as a
 * development / test environment, which matches Next.js conventions
 * (`next dev` sets `NODE_ENV='development'`, vitest leaves it unset or
 * `'test'`). Computed once at module load — the env var is not expected
 * to change after process start.
 */
const isProduction = env.NODE_ENV === 'production';

/**
 * Build the pino options used to construct the singleton.
 *
 * Split out into its own function (rather than inlined) so unit tests
 * could conceivably re-derive the same configuration without touching
 * the cached singleton, and so the production / development branches
 * are easy to read at a glance.
 */
function buildLoggerOptions(): LoggerOptions {
  const level = process.env.LOG_LEVEL ?? 'info';

  // Production: emit NDJSON straight to stdout so external aggregators
  // (Datadog, Loki, CloudWatch) can ingest it without further parsing.
  if (isProduction) {
    return { level };
  }

  // Development / test: route through pino-pretty for colourised,
  // human-friendly output. `pino-pretty` is a runtime peer dep that
  // ships in `package.json`, so the transport target resolves
  // reliably during `npm run dev`.
  return {
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    },
  };
}

/**
 * Construct a fresh logger instance configured for the current
 * environment. Called at most once per process (or per HMR cycle in
 * development) — see the `globalThis` cache below.
 */
function createLogger(): Logger {
  return pino(buildLoggerOptions());
}

/**
 * The shared `pino` logger instance.
 *
 * - In production: created once per process at module load.
 * - In development: cached on `globalThis.__logger__` so Next.js HMR
 *   reloads reuse the same logger (and its underlying pino-pretty
 *   worker) instead of spinning up a new one on every file change.
 */
export const logger: Logger = globalForLogger.__logger__ ?? createLogger();

if (!isProduction) {
  globalForLogger.__logger__ = logger;
}

export default logger;
