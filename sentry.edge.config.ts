/**
 * @file Sentry edge-runtime initialisation.
 *
 * Used by Next.js when middleware or route handlers run on the edge
 * runtime (`export const runtime = 'edge'`). The MVP currently uses
 * `runtime = 'nodejs'` everywhere, but `@sentry/nextjs` still requires
 * this config to be present so the build does not fail when the edge
 * runtime is opted into in the future.
 */

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  enabled: process.env.NODE_ENV === 'production',
});
