/**
 * @file Vitest test environment defaults.
 *
 * Imported explicitly from each test file's first line:
 *
 * ```ts
 * import '../setup'; // (or ../../setup, ../../../setup …)
 * ```
 *
 * Why explicit-import instead of `vitest.config.ts > setupFiles`?
 *
 *   On Windows hosts where the workspace lives on a junction
 *   (e.g. the user folder under `C:\Users\...\helio02` is a junction
 *   pointing to `E:\MigratedFromC\...`), vite's jsdom worker resolves
 *   absolute paths through the junction target while the parent
 *   process uses the source. A shared `setupFiles` entry fails to
 *   load with `Failed to load url C:/... (resolved id: E:/...)`.
 *   Importing the setup module relatively from each test side-steps
 *   the issue because the relative path is normalised against the
 *   test file itself, keeping both ends on the same drive letter.
 *
 * The file is `import`-only (no top-level test hooks); side effects
 * are limited to `process.env` defaulting so it is safe to import
 * from any number of test files.
 */

// Env defaults for every test process. Set BEFORE any module that
// imports `@/lib/env` is loaded so its zod parser sees these values
// (the env validator calls `process.exit(1)` on missing required
// vars in production; in tests we want a stub instead).
// NODE_ENV is typed readonly in @types/node when the Next.js types
// are present, so use a defineProperty assignment to bypass.
if (!process.env.NODE_ENV) {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'test',
    configurable: true,
    writable: true,
  });
}
process.env.DEEPSEEK_API_KEY ??= 'sk-deepseek-test-key-placeholder';
process.env.DATABASE_URL ??=
  'postgresql://test:test@localhost:5432/test?schema=public';
process.env.NEXTAUTH_SECRET ??=
  'test-secret-32-characters-minimum-aaaa';
process.env.AI_DAILY_BUDGET_USD ??= '5';
process.env.AI_AGENT_INTERVAL_MS ??= '30000';
process.env.WORKSPACE_ID ??= 'ws_test';
