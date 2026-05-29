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

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim().length === 0
    ? undefined
    : value;
}

function nonEmptyEnv(
  source: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = source[key];
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function encodeConnectionPart(value: string): string {
  return encodeURIComponent(value);
}

function resolveDatabaseUrl(source: NodeJS.ProcessEnv): string | undefined {
  for (const key of [
    'DATABASE_URL',
    'POSTGRES_URL',
    'POSTGRES_PRISMA_URL',
    'DATABASE_PRIVATE_URL',
    'DATABASE_PUBLIC_URL',
  ]) {
    const value = nonEmptyEnv(source, key);
    if (value) return value;
  }

  const host = nonEmptyEnv(source, 'PGHOST');
  const port = nonEmptyEnv(source, 'PGPORT') ?? '5432';
  const user = nonEmptyEnv(source, 'PGUSER');
  const password = nonEmptyEnv(source, 'PGPASSWORD');
  const database = nonEmptyEnv(source, 'PGDATABASE');

  if (!host || !user || !password || !database) return undefined;

  return `postgresql://${encodeConnectionPart(user)}:${encodeConnectionPart(
    password,
  )}@${host}:${port}/${encodeConnectionPart(database)}?schema=public`;
}

function normaliseProcessEnv(): void {
  const databaseUrl = resolveDatabaseUrl(process.env);
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
  }

  if (process.env.NEXT_PUBLIC_SOCKET_URL?.trim().length === 0) {
    delete process.env.NEXT_PUBLIC_SOCKET_URL;
  }
}

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
 *   - `NEXT_PUBLIC_SOCKET_URL`  — optional; browser code falls back to
 *                                  the current origin when unset
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
    .preprocess(
      emptyStringToUndefined,
      z.string({ required_error: 'DATABASE_URL is required' }),
    )
    .pipe(z.string().min(1, 'DATABASE_URL must not be empty')),

  NEXTAUTH_SECRET: z
    .preprocess(
      emptyStringToUndefined,
      z.string({ required_error: 'NEXTAUTH_SECRET is required' }),
    )
    .pipe(z.string().min(32, 'NEXTAUTH_SECRET must be at least 32 characters')),

  REDIS_URL: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default('redis://localhost:6379'),

  NEXT_PUBLIC_SOCKET_URL: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default(''),

  AI_DAILY_BUDGET_USD: z.coerce
    .number()
    .nonnegative('AI_DAILY_BUDGET_USD must be ≥ 0')
    .default(5),

  /**
   * USD pricing per 1,000,000 input / output tokens used by the budget
   * tracker (`lib/ai/budget.ts`). Defaults to DeepSeek's published
   * cache-MISS pricing as of 2026-05; override either when a price
   * change ships from the provider or when pinning to a different
   * model with different rates (audit finding L1).
   */
  AI_INPUT_PRICE_PER_M_USD: z.coerce
    .number()
    .nonnegative('AI_INPUT_PRICE_PER_M_USD must be ≥ 0')
    .default(1.07),

  AI_OUTPUT_PRICE_PER_M_USD: z.coerce
    .number()
    .nonnegative('AI_OUTPUT_PRICE_PER_M_USD must be ≥ 0')
    .default(1.1),

  /**
   * Notice posted to `#general` when the daily AI budget trips the
   * circuit breaker. Operators can localise this without code changes
   * (audit nit L11). The default keeps the original Simplified Chinese
   * notice for backward compatibility.
   */
  AI_BUDGET_EXCEEDED_NOTICE: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default('⚠️ AI 今日预算已用尽，将于明日 UTC 0 点恢复'),

  AI_AGENT_INTERVAL_MS: z.coerce
    .number()
    .int('AI_AGENT_INTERVAL_MS must be an integer')
    .positive('AI_AGENT_INTERVAL_MS must be > 0')
    .default(30_000),

  /**
   * Real-tool configuration for the new `web_search` /
   * `read_project_docs` tools added in Phase 1 (Req 12). Missing
   * values disable the corresponding tool gracefully — the dispatcher
   * still routes the call but `withSafeExecution` returns
   * `is_error: true` with a clear "tool not configured" message so
   * the AI can self-correct on the next round.
   */
  TAVILY_API_KEY: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default(''),

  SERPER_API_KEY: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default(''),

  WEB_SEARCH_PROVIDER: z
    .enum(['tavily', 'serper'])
    .default('tavily'),

  /** Per-call USD cost charged to {@link Budget.trackOther} for every
   *  successful `web_search` invocation (Req 12.6). Default biases
   *  the breaker toward tripping a touch early. */
  WEB_SEARCH_COST_USD: z.coerce
    .number()
    .nonnegative('WEB_SEARCH_COST_USD must be ≥ 0')
    .default(0.001),

  /** Optional GitHub PAT or Actions token for `read_project_docs`.
   *  When unset, requests go anonymously and share the 60 req/h
   *  unauthenticated rate limit. */
  GITHUB_TOKEN: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default(''),

  /**
   * When `true`, the Agentic Loop fires every
   * `AI_AGENT_INTERVAL_MS` ms and wakes every AI whether or not a
   * human has spoken to them. Useful for live demos and the spec's
   * "self-driving teammate" feel.
   *
   * When `false` (the default), the periodic tick is suppressed
   * entirely — the AI only acts when a human directly mentions it
   * (e.g. "@Ada ..." in a channel) or when an approval transitions
   * `PENDING → APPROVED`. This stops the AIs from chatting with
   * themselves at $0.10/min when the workspace is idle, which is
   * what you want during normal use.
   *
   * Coerced from the string `process.env` value via
   * `z.string().transform(...)` so any of the common truthy spellings
   * (`true`, `1`, `on`, `yes`) flips the flag without forcing the
   * operator to remember exact casing.
   */
  AI_AUTO_TICK: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return false;
      const normalised = v.trim().toLowerCase();
      return ['1', 'true', 'on', 'yes'].includes(normalised);
    }),

  WORKSPACE_ID: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default('ws_default'),

  /**
   * Brand decoupling (Phase 1 Req 16). These configure the seeded
   * workspace identity so no brand string is hard-coded in the data
   * layer. They are consumed by `prisma/seed.ts`.
   *
   * - `WORKSPACE_NAME`     — display name of the single workspace.
   * - `AI_AGENT_NAMES_JSON`— JSON array describing the seeded AI
   *   colleagues. Parsed + validated inside the seed script (not
   *   here) so a malformed value only fails `prisma:seed`, never a
   *   running server process.
   * - `SEED_EMAIL_DOMAIN`  — email domain for seeded users.
   *
   * Defaults are left empty here; `prisma/seed.ts` supplies the
   * legacy `Helio` / `Ada` / `Hopper` / `helio.local` values ONLY in
   * development so local dev + e2e keep working unchanged, while
   * production refuses to seed without explicit configuration
   * (mirrors the SEED_HUMAN_PASSWORD discipline from audit M5).
   */
  WORKSPACE_NAME: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default(''),

  AI_AGENT_NAMES_JSON: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default(''),

  SEED_EMAIL_DOMAIN: z
    .preprocess(emptyStringToUndefined, z.string().min(1).optional())
    .default(''),

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
  normaliseProcessEnv();

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
