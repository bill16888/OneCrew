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
 * - Every other path requires a valid NextAuth JWT session. Visitors
 *   without a session are redirected (HTTP 302) to `/login` by
 *   `withAuth`, which honours the `pages.signIn` value set below.
 *
 * Implementation notes:
 * - We use the `withAuth` helper from `next-auth/middleware`. It reads
 *   the session cookie (JWT strategy, see `lib/auth/options.ts`) and
 *   issues the redirect for us, so this file stays declarative.
 * - The exclusions live in `config.matcher` (a negative lookahead)
 *   rather than inside the middleware body. Excluded paths skip this
 *   middleware entirely, which is both cheaper and avoids any chance
 *   of redirecting `/login` to itself.
 * - `pages.signIn` here mirrors `authOptions.pages.signIn` to make the
 *   redirect target explicit and resilient to refactors.
 *
 * Validates: Requirements 1.5.
 */

import { withAuth } from 'next-auth/middleware';

/**
 * The configured Next.js middleware. `withAuth` returns a
 * `NextMiddlewareWithAuth` that gates every request against the
 * NextAuth JWT cookie and redirects unauthenticated users to `/login`.
 *
 * The return type is inferred from `withAuth` so the augmented
 * `req.nextauth` field stays available without a manual cast.
 */
const middleware = withAuth({
  pages: { signIn: '/login' },
});

export default middleware;

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
 * Everything else (including the workspace root, `/board`, and
 * `/channels/...`) is protected.
 */
export const config = {
  matcher: [
    '/((?!login|api/health|api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
