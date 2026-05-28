/**
 * NextAuth.js configuration for the AI-Native Team Workspace.
 *
 * Auth model (per design.md, Auth section):
 * - Credentials Provider with email + password.
 * - Passwords are stored as bcrypt hashes on `User.passwordHash` (humans only).
 * - AI colleagues have `isAI = true` and `passwordHash = null`; they MUST NOT
 *   be able to authenticate as a human, so `authorize` rejects any user where
 *   `isAI === true` or `passwordHash` is missing.
 * - Session strategy is `'jwt'` so the same token can be parsed in both the
 *   HTTP layer and the Socket.io handshake (single-process server.ts).
 * - The JWT carries the persistent user id as `token.uid`; the session
 *   callback projects that back to `session.user.id`.
 *
 * Module augmentation that adds `id` to `Session['user']` and `uid` to the
 * JWT lives in `types/next-auth.d.ts` and is picked up automatically by
 * the default TypeScript include in `tsconfig.json`.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4.
 */

import { compare } from 'bcryptjs';
import type { NextAuthOptions, User as NextAuthUser } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';

import prisma from '@/lib/prisma';
import { rateLimit } from '@/lib/ratelimit';

/**
 * Tight per-(IP, email) bucket on credential checks. NextAuth's
 * `authorize` is reachable without a session, so it sits OUTSIDE the
 * `/api/*` rate limit applied by the API helpers — the only thing
 * standing between an attacker and the bcrypt verifier is this gate.
 *
 * 5 attempts per minute is generous enough not to lock out a typo-
 * prone human but tight enough that the bcrypt cost (rounds 12,
 * ~150 ms on commodity hardware) bounds the attack rate well below
 * the network ceiling (audit follow-up to PR #1).
 */
const LOGIN_LIMIT = { capacity: 5, windowMs: 60_000 } as const;

/**
 * Best-effort client identifier for rate-limit keying. NextAuth v4
 * passes the underlying request as the second argument to `authorize`,
 * exposing reverse-proxy headers we can use as a coarse IP. We pair
 * this with the submitted email so two attackers behind the same NAT
 * are still bucketed independently.
 */
function clientIp(req: { headers?: Record<string, string | string[] | undefined> } | undefined): string {
  const header = (key: string): string | undefined => {
    const value = req?.headers?.[key];
    if (Array.isArray(value)) return value[0];
    return typeof value === 'string' ? value : undefined;
  };
  const fwd = header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return header('x-real-ip') ?? 'unknown';
}

/**
 * NextAuth options consumed by the App Router catch-all route at
 * `app/api/auth/[...nextauth]/route.ts` and by server-side helpers such
 * as `getServerSession(authOptions)`.
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      /**
       * Verify a human user's email + password.
       *
       * Returns the minimal `User` shape NextAuth expects on success, or
       * `null` to signal authentication failure. Per the spec, AI users
       * and users without a `passwordHash` are rejected (no session is
       * ever created for them).
       *
       * Per-(IP, email) rate limiting runs BEFORE the bcrypt compare so
       * a brute-force attacker cannot use the verifier as a CPU oracle
       * (audit follow-up to PR #1). Returning `null` on rate-limit hit
       * keeps the response indistinguishable from a bad password — the
       * attacker cannot tell whether they hit the cap or guessed wrong.
       */
      async authorize(credentials, req): Promise<NextAuthUser | null> {
        const email = credentials?.email?.trim();
        const password = credentials?.password;
        // Both fields must be non-empty after trimming. We deliberately do
        // NOT use the trimmed password for bcrypt comparison, since
        // surrounding whitespace can be legitimate password content.
        if (!email || !password || password.trim().length === 0) {
          return null;
        }

        // Bucket key: lower-cased email + first IP from the
        // X-Forwarded-For header. Two attackers behind the same NAT
        // therefore share buckets only if they target the same email,
        // which is the threat we care about here.
        const ip = clientIp(req as { headers?: Record<string, string | string[] | undefined> } | undefined);
        const bucketKey = `${ip}|${email.toLowerCase()}`;
        const verdict = rateLimit('auth.credentials', bucketKey, LOGIN_LIMIT);
        if (!verdict.ok) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;
        // Reject AI colleagues and any user that has no password hash.
        if (user.isAI || !user.passwordHash) return null;

        const ok = await compare(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
  ],
  callbacks: {
    /**
     * Persist the database user id on the JWT as `uid` so that downstream
     * consumers (HTTP routes and the Socket.io session middleware) can
     * read a stable identifier without re-querying the user record.
     */
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
      }
      return token;
    },
    /**
     * Surface `token.uid` to the client-facing session as
     * `session.user.id`. Type augmentation in `types/next-auth.d.ts`
     * keeps this strongly typed.
     */
    async session({ session, token }) {
      if (token.uid && session.user) {
        session.user.id = token.uid;
      }
      return session;
    },
  },
  pages: { signIn: '/login' },
};

export default authOptions;
