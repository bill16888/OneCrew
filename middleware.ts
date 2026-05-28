/**
 * Protected-route guard for the AI-Native Team Workspace.
 *
 * Behaviour (per task 4.4 / Requirements 1.5):
 * - The `/login` page, `/api/health` liveness probe, and all
 *   `/api/auth/*` endpoints are publicly accessible so unauthenticated
 *   users can actually sign in and platform health checks can receive
 *   a real `200` instead of an auth redirect.
 * - Next.js static assets (`/_next/static`, `/_next/image`,
 *   `favicon.ico`, and any path that looks like a static file —
 *   anything containing a `.` segment) are also bypassed.
 * - HTML page requests under any other path require a valid NextAuth
 *   JWT session. Visitors without a session are redirected (HTTP 302)
 *   to `/login` by `withAuth`.
 * - **API routes** (anything starting with `/api/`) use the same
 *   session check, but unauthenticated callers receive a JSON
 *   `401 { error: 'Unauthorized' }` rather than the HTML redirect.
 *   This matters for fetch / XHR clients (the SPA, the AI tool
 *   surface, third-party callers): a 302 to `/login` would otherwise
 *   surface as HTML masquerading as a JSON failure (audit finding H3).
 *
 * Implementation notes:
 * - We compose the page guard from `withAuth` (HTML redirect) and a
 *   custom JSON guard for `/api/*`. Both use the same JWT lookup via
 *   `next-auth/jwt → getToken`, so the auth contract stays singular.
 * - The exclusions live in `config.matcher` (a negative lookahead) so
 *   excluded paths skip this middleware entirely; this is both cheaper
 *   and avoids any chance of redirecting `/login` to itself.
 *
 * Validates: Requirements 1.5; audit finding H3.
 */

import { getToken } from 'next-auth/jwt';
import { withAuth } from 'next-auth/middleware';
import { NextResponse, type NextRequest } from 'next/server';

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

/**
 * Page guard returned by `withAuth`: handles HTML redirects to
 * `/login` for unauthenticated users.
 */
const pageGuard = withAuth({
  pages: { signIn: '/login' },
});

/**
 * Custom guard for `/api/*` paths. Returns a JSON 401 instead of an
 * HTML redirect so fetch / XHR callers receive a parsable error.
 */
async function apiGuard(req: NextRequest): Promise<NextResponse> {
  const token = await getToken({
    req,
    // `getToken` accepts `secret: undefined` and falls back to
    // `NEXTAUTH_SECRET` from the env, but typing it explicitly here
    // avoids a `process.env` read inside the hot path on every
    // request (Edge runtime gives `process.env` lazy proxies).
    secret: NEXTAUTH_SECRET,
  });
  if (token === null) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: {
          // Tell well-behaved API clients which auth scheme to use
          // when retrying.
          'WWW-Authenticate': 'Session realm="kiro"',
          // Prevent caches and CDNs from holding onto a 401 — the
          // client's session might be created the very next request.
          'Cache-Control': 'no-store',
        },
      },
    );
  }
  return NextResponse.next();
}

/**
 * Top-level middleware: route to the JSON guard for API paths and to
 * the HTML redirect guard for everything else.
 */
export default async function middleware(
  req: NextRequest,
): Promise<NextResponse> {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return apiGuard(req);
  }
  // `withAuth` returns a `NextMiddlewareWithAuth` whose return type is
  // `NextResponse | Promise<NextResponse | undefined> | undefined`. We
  // resolve it to a concrete `NextResponse` (defaulting to `next()`)
  // so callers always get a response object.
  const result = await (pageGuard as unknown as (
    request: NextRequest,
  ) => Promise<NextResponse | undefined> | NextResponse | undefined)(req);
  return result ?? NextResponse.next();
}

/**
 * Matcher configuration for Next.js middleware.
 *
 * The negative lookahead skips:
 *   - `login` (the public sign-in page and any nested `/login/...` route),
 *   - `api/health` (Railway / container liveness probes),
 *   - `api/auth` (NextAuth's own endpoints, including the credentials POST),
 *   - `_next/static` and `_next/image` (Next.js build assets),
 *   - `favicon.ico`,
 *   - any path whose final segment contains a dot (e.g. `.png`, `.svg`,
 *     `.css`, `.js`) — i.e. served-as-is static files.
 *
 * Everything else (including the workspace root, `/board`, every
 * `/channels/...` page, and every protected `/api/*` route) is gated.
 */
export const config = {
  matcher: [
    '/((?!login|api/health|api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
