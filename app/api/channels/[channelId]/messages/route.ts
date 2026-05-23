/**
 * GET `/api/channels/[channelId]/messages` route handler.
 *
 * Returns the message history of a single channel ordered by
 * `createdAt` ascending (oldest first), matching the natural reading
 * order in the UI. The client-side channel page (task 3.9) hydrates
 * its initial timeline from this endpoint and then patches in
 * `message:new` realtime events.
 *
 * Contract:
 *   - Method: `GET`
 *   - Auth: requires a valid NextAuth session; missing session ⇒
 *     `401 { error }`.
 *   - Path param: `channelId` (cuid). When the channel does not exist
 *     we return `200 []` rather than `404`, mirroring
 *     `ChannelService.getMessages` semantics — the route does not
 *     verify channel existence on its own.
 *   - Responses:
 *     - `200 Message[]` on success (oldest-first).
 *     - `400 { error }` when `channelId` is empty.
 *     - `401 { error }` when the request has no NextAuth session.
 *     - `500 { error }` for unexpected persistence failures.
 *
 * Validates: Requirements 2.2.
 *
 * @module app/api/channels/[channelId]/messages/route
 */

import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '@/lib/auth/options';
import { ChannelService } from '@/lib/services/channel.service';

/** Always run this route on the Node.js runtime (Prisma needs Node APIs). */
export const runtime = 'nodejs';
/** Disable static optimization — this is a session-bound, DB-backed read. */
export const dynamic = 'force-dynamic';

/**
 * Path parameters injected by Next.js for the dynamic
 * `[channelId]` segment.
 */
interface RouteContext {
  params: { channelId: string };
}

/**
 * Handle `GET /api/channels/[channelId]/messages`. See module docs for
 * the full contract.
 */
export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  const channelId = context.params.channelId;
  if (typeof channelId !== 'string' || channelId.length === 0) {
    return NextResponse.json(
      { error: 'Path parameter "channelId" must be a non-empty string.' },
      { status: 400 },
    );
  }

  try {
    const messages = await ChannelService.getMessages(channelId);
    return NextResponse.json(messages, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: 'Failed to load channel messages.' },
      { status: 500 },
    );
  }
}
