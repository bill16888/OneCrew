import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // OpenAI SDK (used to call DeepSeek) and other Node-only deps stay
    // on the server so they don't get bundled into client components.
    serverComponentsExternalPackages: ['openai', 'pino', 'pino-pretty'],
  },
};

/**
 * Wrap the Next.js config with `@sentry/nextjs` so the build picks up
 * Sentry's webpack plugins (source map upload, server bundle
 * instrumentation). When `SENTRY_AUTH_TOKEN` is unset the plugin
 * silently skips the upload step, so this stays safe to ship without
 * Sentry credentials in development.
 *
 * - `silent: true`            — suppress the verbose plugin banner.
 * - `org` / `project`         — read from env so they live alongside
 *                               other Sentry secrets in `.env.prod`.
 *
 * Validates: Operational concerns (P1 task #3 — Sentry).
 */
export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});
