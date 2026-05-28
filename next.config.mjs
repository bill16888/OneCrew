import { withSentryConfig } from '@sentry/nextjs';

/**
 * Default security headers applied to every response.
 *
 * Compose-time defaults — operators can extend or override these via
 * a custom proxy (e.g. Cloudflare) without touching the app. The list
 * is intentionally conservative; we MAY relax `Content-Security-Policy`
 * when a third-party tool surfaces a real-world block (audit finding L5).
 *
 * - `Strict-Transport-Security`: 1-year HSTS, applies to subdomains.
 *   Safe to ship because the production deployment is HTTPS-only;
 *   browsers ignore this header on plain-HTTP responses anyway.
 * - `X-Content-Type-Options: nosniff` blocks MIME sniffing attacks.
 * - `X-Frame-Options: DENY` prevents clickjacking. The app has no
 *   legitimate same-domain framing use case.
 * - `Referrer-Policy: strict-origin-when-cross-origin` keeps full URLs
 *   on same-origin navigation but strips them when leaving the site.
 * - `Permissions-Policy` denies access to high-risk browser APIs
 *   we never use (camera/microphone/geolocation/etc.).
 * - `Content-Security-Policy` restricts script/connect sources to
 *   self + Sentry (used by `@sentry/nextjs`'s ingest endpoint) and
 *   allows the inline scripts Next.js injects for hydration via
 *   `'unsafe-inline'`. We keep it explicit so a future hardening
 *   pass (nonce-based CSP) has a clear target.
 */
const SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // Next.js inlines hydration data; Sentry's tracing client is
      // loaded lazily from /_next/static. `'unsafe-inline'` is the
      // pragmatic compromise for an MVP — a follow-up can swap to
      // a nonce-based policy.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://*.ingest.sentry.io https://*.sentry.io wss: https:",
      "object-src 'none'",
      "worker-src 'self' blob:",
    ].join('; '),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // OpenAI SDK (used to call DeepSeek) and other Node-only deps stay
    // on the server so they don't get bundled into client components.
    serverComponentsExternalPackages: ['openai', 'pino', 'pino-pretty'],
  },
  /**
   * Apply the security header bundle to every route.
   * Per Next.js docs, headers declared here are merged with anything
   * a route handler emits via `NextResponse.headers.set(...)`.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ];
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
