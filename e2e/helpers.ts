/**
 * @file Shared helpers for Playwright smoke tests.
 *
 * Login is the most common per-test prelude, so we hoist it into a
 * single helper that mirrors the form fields rendered by
 * `app/(auth)/login/page.tsx`. The seeded credentials match
 * `prisma/seed.ts` (`mia@onecrew.local` / `password123`) — keep these in
 * sync if the seed changes.
 */

import { expect, type Page } from '@playwright/test';

/** Default seeded human user (kept in lock-step with `prisma/seed.ts`). */
export const DEFAULT_TEST_EMAIL = 'mia@onecrew.local';
export const DEFAULT_TEST_PASSWORD = 'password123';

/**
 * Drive the login form and wait for the post-login redirect.
 *
 * The form uses native `name="email"` / `name="password"` inputs and a
 * `type="submit"` button. After a successful submit, NextAuth redirects
 * to `/` (the workspace home), which is what we wait on.
 *
 * @param page     A fresh Playwright `Page`.
 * @param email    Seeded user email. Defaults to {@link DEFAULT_TEST_EMAIL}.
 * @param password Plaintext password. Defaults to
 *                 {@link DEFAULT_TEST_PASSWORD}.
 */
export async function loginAs(
  page: Page,
  email: string = DEFAULT_TEST_EMAIL,
  password: string = DEFAULT_TEST_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), {
      timeout: 10_000,
    }),
    page.click('button[type="submit"]'),
  ]);
  // Cheap sanity check — the workspace shell renders the AI Teammates
  // section in the sidebar after auth resolves.
  await expect(page).not.toHaveURL(/\/login/);
}
