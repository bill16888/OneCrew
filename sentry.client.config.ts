/**
 * @file Sentry client-side initialisation.
 *
 * Loaded automatically by the `@sentry/nextjs` runtime in every browser
 * bundle. We keep the config small and entirely env-driven so the same
 * code runs in dev (where Sentry stays disabled) and prod (where DSN
 * + sample rate are honoured).
 *
 * - `enabled` is gated on `NODE_ENV === 'production'` so dev / test
 *   sessions never ship events upstream.
 * - `tracesSampleRate: 0.1` keeps 10% of transactions; raise in prod
 *   when traffic is small enough to justify the noise.
 * - The DSN is the only secret here; it is intentionally a public env
 *   var (`NEXT_PUBLIC_*`) because Sentry validates origins server-side.
 */

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  enabled: process.env.NODE_ENV === 'production',
});
