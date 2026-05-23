/**
 * @file Playwright configuration for the smoke-test suite.
 *
 * The suite covers four critical user journeys (login, send message,
 * create task, approval flow) and is intended to run before every
 * deploy as a deployability gate. CI is *not* expected to run these
 * tests today (they need a full stack: PostgreSQL + Redis + Anthropic);
 * see `.github/workflows/ci.yml` for the lighter typecheck-only check.
 *
 * - `baseURL` is taken from `PLAYWRIGHT_BASE_URL` so the same suite
 *   can run against `localhost`, a staging environment, or a Railway
 *   preview URL without code changes.
 * - `webServer` boots `npm run dev` automatically when no other
 *   server is reachable on port 3000; `reuseExistingServer: true`
 *   keeps a manually-started dev server intact.
 * - Chromium-only: this is a smoke surface, not a cross-browser
 *   compatibility suite. Install other browsers explicitly when
 *   the scope expands.
 *
 * Validates: Operational concerns (P2 task #4 — Playwright smoke).
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: 'e2e',
  // Default per-test timeout. Smoke tests are short; if any test
  // legitimately needs more time it can override via `test.setTimeout`.
  timeout: 30_000,
  // Allow exactly one retry for the rare flake (Socket.io reconnect
  // delay, Next.js dev cold start). More retries would mask real
  // regressions.
  retries: 1,
  // The four smoke specs share a workspace via Prisma seed data, so
  // running them in parallel inside one worker would be racy. Pin to a
  // single worker; we trade wall-clock speed for determinism.
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // Trace on first retry so a failure is debuggable without re-running.
    trace: 'on-first-retry',
    // Headless by default; pass `--headed` on the CLI for debugging.
    headless: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
