/**
 * NextAuth.js module augmentation.
 *
 * - `Session['user'].id` exposes the persistent database user id to client
 *   components and to server-side helpers consuming `getServerSession`.
 * - `JWT.uid` mirrors that id on the underlying token so the Socket.io
 *   handshake middleware (single-process server.ts) can authenticate
 *   connections without an extra DB round-trip.
 *
 * This file is picked up automatically via the default TypeScript include
 * pattern in `tsconfig.json`; it intentionally only declares ambient types
 * and emits no runtime code.
 */

import type { DefaultSession, DefaultUser } from 'next-auth';
import type { JWT as DefaultJWT } from 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      /** Persistent database user id (cuid). */
      id: string;
    } & DefaultSession['user'];
  }

  interface User extends DefaultUser {
    /** Persistent database user id (cuid). */
    id: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    /** Persistent database user id, set in the `jwt` callback. */
    uid?: string;
  }
}

export {};
