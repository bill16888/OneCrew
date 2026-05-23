/**
 * @file Property test for the NextAuth Credentials authorize flow.
 *
 * Property 1 (认证基于 bcrypt 的双向正确性):
 *   - For any seeded `(email, password)`, authorize returns the user.
 *   - For any password ≠ password or unknown email, returns null.
 *
 * We mock `prisma.user.findUnique` so the test does not need a live
 * database. bcrypt comparison runs on the real hash, so the property
 * actually exercises the verification path.
 *
 * Validates: Requirements 1.2, 1.3 (P2 task 4.6).
 */

import '../../setup';

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { hashSync } from 'bcryptjs';

const userTable = new Map<
  string,
  { id: string; email: string; name: string; passwordHash: string | null; isAI: boolean }
>();

vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => {
        return userTable.get(where.email) ?? null;
      }),
    },
  },
}));

import { authOptions } from '@/lib/auth/options';

/**
 * Pull the Credentials provider's `authorize` callback directly.
 * NextAuth's provider type is loose; we narrow with a small helper to
 * keep the test typed without `any`.
 */
function getAuthorize(): (
  credentials?: Record<string, string>,
) => Promise<{ id: string; email: string; name: string } | null> {
  const provider = authOptions.providers[0] as unknown as {
    options: {
      authorize: (
        credentials?: Record<string, string>,
      ) => Promise<{ id: string; email: string; name: string } | null>;
    };
  };
  return provider.options.authorize;
}

describe('Feature: ai-native-team-workspace, Property 1: bcrypt 双向认证正确性', () => {
  it('accepts the correct password and rejects everything else', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.emailAddress(),
          fc.string({ minLength: 4, maxLength: 24 }),
          fc.string({ minLength: 4, maxLength: 24 }),
        ),
        async ([email, correctPassword, wrongPassword]) => {
          fc.pre(correctPassword !== wrongPassword);
          // Seed exactly this user for this iteration.
          userTable.clear();
          userTable.set(email, {
            id: `user_${email}`,
            email,
            name: email.split('@')[0],
            passwordHash: hashSync(correctPassword, 4), // low rounds for speed
            isAI: false,
          });

          const authorize = getAuthorize();

          // 1. Correct credentials → user payload.
          const ok = await authorize({ email, password: correctPassword });
          expect(ok).not.toBeNull();
          expect(ok?.email).toBe(email);

          // 2. Wrong password → null.
          const wrong = await authorize({ email, password: wrongPassword });
          expect(wrong).toBeNull();

          // 3. Unknown email → null.
          const unknown = await authorize({
            email: `${email}.unknown`,
            password: correctPassword,
          });
          expect(unknown).toBeNull();
        },
      ),
      { numRuns: 30 }, // bcrypt is the bottleneck; keep run count modest
    );
  });

  it('rejects AI users even with the right password', async () => {
    userTable.clear();
    userTable.set('ada@helio.local', {
      id: 'user_ai_ada',
      email: 'ada@helio.local',
      name: 'Ada',
      // Even with a hash, isAI=true must short-circuit.
      passwordHash: hashSync('whatever', 4),
      isAI: true,
    });
    const authorize = getAuthorize();
    const result = await authorize({
      email: 'ada@helio.local',
      password: 'whatever',
    });
    expect(result).toBeNull();
  });
});
