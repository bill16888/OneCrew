/**
 * @file Vitest configuration for unit + property-based tests.
 *
 * Two project shapes share a single config so a flat `npm run test`
 * picks both up:
 *   - **Node tests** (default) — service / library code that runs on
 *     the server side (`lib/**`, `scripts/**`).
 *   - **DOM tests** — React component tests that need `jsdom`. We tag
 *     them by file name (`*.test.tsx` is auto-detected; the
 *     `environmentMatchGlobs` array below pins the runtime).
 *
 * The path alias `@/` is mapped explicitly so vite's resolver picks
 * it up without an extra plugin. We use `process.cwd()` instead of
 * `__dirname` for the alias because Windows junction targets can
 * surface a different drive letter than the one the test runner was
 * invoked under, which trips up vite's case-sensitive module cache.
 *
 * Property-based tests use `fast-check` (already in devDependencies)
 * and target ≥100 iterations per property by default.
 */

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const ROOT = process.cwd();

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(ROOT, '.'),
    },
  },
  // Switch JSX to the automatic runtime so .tsx components in
  // tests/components/ can be `renderToString`-ed without having to
  // `import React from 'react'` (the project's tsconfig sets
  // "jsx": "preserve", relying on Next.js's automatic runtime in
  // production; this aligns the test transform with that setup).
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Default to node. The few component-level tests we keep are
    // formatter / pure-function checks (see tests/components/) and
    // do not need jsdom; rendering React under jsdom proved unstable
    // on Windows hosts whose workspace lives behind a drive junction.
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    // Exclude Playwright suites (they live under `e2e/`) so the
    // unit-test runner does not try to drive them.
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      '**/e2e/**',
      '**/dist/**',
    ],
    // Most PBT runs converge well under 5s; raise to 30s as a soft
    // ceiling so a flaky shrink does not hang CI.
    testTimeout: 30_000,
    // One worker keeps singletons (budget tracker, agentic emitter)
    // deterministic across files.
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    // No global `setupFiles`. On Windows hosts where the workspace
    // sits on a junction (e.g. `C:` → `E:\MigratedFromC`), vite's
    // jsdom worker resolves paths through the junction *target* while
    // the parent test runner uses the source, so a shared setup file
    // fails to load. Each test file imports `./setup` (or its
    // siblings via relative paths) explicitly when it needs the env
    // defaults, which keeps the loader on a single drive.
    reporters: ['default'],
  },
});
