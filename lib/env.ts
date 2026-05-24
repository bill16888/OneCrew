/**
 * @file Centralised, validated environment configuration.
 *
 * Importing this module performs **eager** validation: if any required
 * variable is missing or malformed, the process prints a structured
 * `❌ Missing env vars` block and calls `process.exit(1)` immediately.
 * That prevents subtle runtime failures (silent `undefined` everywhere)
 * and makes container startup fail fast with a clear diagnostic instead
 * of crashing later inside the AI runtime or Prisma.
 *
 * Wire this in `server.ts` as the very first import so the server can
 * never boot with a half-configured environment:
 *
 * ```ts
 * import '@/lib/env'; // MUST be the first import
 * import { createServer } from 'node:http';
 * // ...
 * ```
 *
 * Throughout the rest of the codebase, prefer `import { env } from
 * '@/lib/env'` over reading `process.env.*` directly. The exported
 * `env` object is fully typed and carries default values, so callers
 * can rely on every field being present and well-formed.
 *
 * Validates: Operational concerns (P0 fix #1).
 */

import { z } from 'zod';

/**
 * Zod schema for the runtime environment.
 *
 * Required:
 *   - `DEEPSEEK_API_KEY`   — non-empty DeepSeek API key (typically
 *     prefixed `sk-`). DeepSeek exposes an OpenAI-compatible HTTP
 *     surface, so the runtime calls it via the `openai` SDK with a
 *     custom `baseURL` (see `lib/ai/anthropic.ts`).
 *   - `DATABASE_URL`       — non-empty PostgreSQL connection string.
 *   - `NEXTAUTH_SECRET`    — at least 32 characters (NextAuth requirement
 *     for JWT signing in production).
 *
 * Optional with defaults:
 *   - `DEEPSEEK_BASE_URL`       — defaults to `https://api.deepseek.com`
 *   - `DEEPSEEK_MODEL`          — defaults to `deepseek-chat`
 *   - `REDIS_URL`               — defaults to `redis://localhost:6379`
 *   - `NEXT_PUBLIC_SOCKET_URL`  — defaults to `http://localhost:3001`
 *   - `AI_DAILY_BUDGET_USD`     — coerced number, defaults to `5`
 *   - `AI_AGENT_INTERVAL_MS`    — coerced number, defaults to `30000`
 *   - `NODE_ENV`                — `'development' | 'production' | 'test'`
 *                                  (defaults to `'development'`)
 */
const envSchema = z.object({
  DEEPSEEK_API_KEY: z
    .string({ required_error: 'DEEPSEEK_API_KEY is required' })
    .min(1, 'DEEPSEEK_API_KEY must not be empty'),

  DEEPSEEK_BASE_URL: z
    .string()
    .min(1)
    .default('https://api.deepseek.com'),

  DEEPSEEK_MODEL: z.string().min(1).default('deepseek-chat'),

  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL must not be empty'),

  NEXTAUTH_SECRET: z
    .string({ required_error: 'NEXTAUTH_SECRET is required' })
    .min(32, 'NEXTAUTH_SECRET must be at least 32 characters'),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  NEXT_PUBLIC_SOCKET_URL: z
    .string()
    .min(1)
    .default('http://localhost:3001'),

  AI_DAILY_BUDGET_USD: z.coerce
    .number()
    .nonnegative('AI_DAILY_BUDGET_USD must be ≥ 0')
    .default(5),

  AI_AGENT_INTERVAL_MS: z.coerce
    .number()
    .int('AI_AGENT_INTERVAL_MS must be an integer')
    .positive('AI_AGENT_INTERVAL_MS must be > 0')
    .default(30_000),

  WORKSPACE_ID: z
    .string()
    .min(1)
    .default('ws_default'),

  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
});

/** Inferred type of the validated environment. */
export type Env = z.infer<typeof envSchema>;

/**
 * Parse `process.env` against {@link envSchema}.
 *
 * On failure, print a single `❌ Missing env vars` block listing every
 * field error and exit with code 1. The exit happens at module load
 * time so the operator sees the diagnostic before any other startup
 * log line, matching the fail-fast contract in P0 fix #1.
 *
 * The function is private to this module: callers consume the
 * pre-validated {@link env} singleton below.
 */
function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) {
    return parsed.data;
  }

  // Collapse Zod issues into `{ field: message }` for a compact,
  // grep-friendly diagnostic. Multiple issues on the same field are
  // joined with `; ` so we never lose information silently.
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
    errors[key] = errors[key]
      ? `${errors[key]}; ${issue.message}`
      : issue.message;
  }

  // eslint-disable-next-line no-console
  console.error('❌ Missing env vars:', errors);
  process.exit(1);
}

/**
 * Process-wide validated environment.
 *
 * Use this everywhere instead of `process.env.*` so callers always
 * receive a typed, defaulted, validated value. The object is frozen at
 * module load and never re-read afterwards.
 */
export const env: Env = loadEnv();

export default env;
