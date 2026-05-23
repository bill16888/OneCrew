/**
 * Prisma client singleton.
 *
 * Why a singleton?
 * `PrismaClient` opens a database connection pool on instantiation. During
 * Next.js development, hot module reloads (HMR) re-evaluate this module
 * every time a file changes; without caching, each reload would spawn a
 * fresh `PrismaClient` and quickly exhaust the PostgreSQL connection
 * limit. We therefore stash a single instance on `globalThis.__prisma__`
 * and reuse it across reloads.
 *
 * In production the module is evaluated exactly once per process, so we
 * skip the global cache and let the client live for the lifetime of the
 * process.
 *
 * Reference: design.md (Architecture, single-process server.ts).
 *
 * @example
 * ```ts
 * import prisma from '@/lib/prisma';
 * const users = await prisma.user.findMany();
 * ```
 */

import { PrismaClient } from '@prisma/client';

import { env } from './env';

/**
 * Shape of the Node global with our cached Prisma client attached.
 * Using a typed alias keeps the singleton fully typed without `any`.
 */
type GlobalWithPrisma = typeof globalThis & {
  __prisma__?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

const isProduction = env.NODE_ENV === 'production';

/**
 * The shared `PrismaClient` instance.
 *
 * - In production: a fresh client created once per process.
 * - In development: cached on `globalThis.__prisma__` so HMR reloads do
 *   not leak database connections.
 */
export const prisma: PrismaClient =
  globalForPrisma.__prisma__ ??
  new PrismaClient({
    log: isProduction ? ['error', 'warn'] : ['error', 'warn'],
  });

if (!isProduction) {
  globalForPrisma.__prisma__ = prisma;
}

export default prisma;
