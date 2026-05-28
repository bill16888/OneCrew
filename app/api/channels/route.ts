/**
 * GET `/api/channels` route handler.
 *
 * Returns every channel that belongs to the hardcoded single workspace
 * (see Requirement 1.7), ordered by `createdAt` ascending. Used by the
 * sidebar / SSR boot to populate the channel list.
 *
 * Contract:
 *   - Method: `GET`
 *   - Auth: requires a valid NextAuth session; missing session ⇒
 *     `401 { error }`.
 *   - Workspace id: read from `process.env.WORKSPACE_ID` and falls back
 *     to `'ws_default'` to match `prisma/seed.ts` and `lib/realtime/io.ts`.
 *   - Responses:
 *     - `200 Channel[]` on success — the array may be empty when the
 *       workspace has no channels (or does not yet exist).
 *     - `401 { error }` when the request has no NextAuth session.
 *     - `500 { error }` for unexpected persistence failures.
 *
 * Note: per-channel message history lives at
 * `/api/channels/[channelId]/messages` so this route stays focused on
 * the channel list itself.
 *
 * Validates: Requirements 2.1.
 *
 * @module app/api/channels/route
 */

import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '@/lib/auth/options';
import { ChannelService } from '@/lib/services/channel.service';
import { resolveWorkspaceId } from '@/lib/workspace';

/** Always run this route on the Node.js runtime (Prisma needs Node APIs). */
export const runtime = 'nodejs';
/** Disable static optimization — this is a session-bound, DB-backed read. */
export const dynamic = 'force-dynamic';

/**
 * Handle `GET /api/channels`. See module docs for the full contract.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  try {
    const channels = await ChannelService.listByWorkspace(resolveWorkspaceId());
    return NextResponse.json(channels, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: 'Failed to load channels.' },
      { status: 500 },
    );
  }
}
