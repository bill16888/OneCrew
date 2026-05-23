/**
 * @file Sentry server-side initialisation.
 *
 * Loaded by `@sentry/nextjs` for both Node.js route handlers and the
 * custom `server.ts`. Mirrors `sentry.client.config.ts` so client and
 * server events share environment + sample rate; the DSN is read from
 * the same env var because Sentry's project bound to a DSN is
 * environment-aware on its own end.
 */

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  enabled: process.env.NODE_ENV === 'production',
});
