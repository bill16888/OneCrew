/**
 * NextAuth.js catch-all route handler for the App Router.
 *
 * Mounts NextAuth at `/api/auth/*` so it can serve every endpoint the
 * Credentials Provider needs (`/api/auth/signin`, `/api/auth/callback/credentials`,
 * `/api/auth/session`, `/api/auth/csrf`, `/api/auth/signout`, ...). Both
 * `GET` and `POST` are exported because NextAuth dispatches different
 * sub-endpoints across both verbs.
 *
 * The actual auth configuration (Credentials Provider, bcrypt verification,
 * JWT session strategy, callbacks injecting `uid`) lives in
 * `lib/auth/options.ts`; this file is intentionally thin so the same
 * `authOptions` can be reused by `getServerSession(authOptions)` and by the
 * Socket.io handshake middleware in `lib/realtime/io.ts`.
 *
 * Validates: Requirements 1.1, 1.4.
 */

import NextAuth from 'next-auth';

import { authOptions } from '@/lib/auth/options';

/**
 * The NextAuth handler is a single function that internally routes to the
 * correct sub-endpoint based on the dynamic `[...nextauth]` segment. Next.js
 * 14's App Router calls it as both a `GET` and `POST` handler, so we re-export
 * the same reference under both verbs.
 */
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
