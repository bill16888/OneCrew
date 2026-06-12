/**
 * `/api/channels/[channelId]/members` — channel membership management
 * (Phase 1 Req 17.5).
 *
 *   - GET    list members of the channel.
 *   - POST   add a user (typically an AI) to the channel.
 *   - DELETE ?userId=... remove a user from the channel.
 *
 * All verbs require a session; writes are rate-limited via
 * `RateLimits.WRITE`. The channel must belong to the active workspace
 * (workspace-boundary discipline, audit H4).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  enforceRateLimit,
  errorResponse,
  requireSession,
  type ApiErrorResponse,
} from '@/lib/api-helpers';
import prisma from '@/lib/prisma';
import { RateLimits } from '@/lib/ratelimit';
import {
  ChannelService,
  type ChannelMemberView,
} from '@/lib/services/channel.service';
import { resolveWorkspaceId } from '@/lib/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  // Next.js 15: dynamic route `params` is asynchronous.
  params: Promise<{ channelId: string }>;
}

const ADD_MEMBER_BODY = z.object({
  userId: z.string().min(1).max(100),
});

/** Confirm the channel exists in the active workspace. */
async function assertChannelInWorkspace(channelId: string): Promise<boolean> {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, workspaceId: resolveWorkspaceId() },
    select: { id: true },
  });
  return channel !== null;
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse<ChannelMemberView[] | ApiErrorResponse>> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const { channelId } = await params;
  if (!(await assertChannelInWorkspace(channelId))) {
    return errorResponse('Channel not found in this workspace.', 404);
  }

  try {
    const members = await ChannelService.listMembers(channelId);
    return NextResponse.json<ChannelMemberView[]>(members, { status: 200 });
  } catch {
    return errorResponse('Failed to load channel members.', 500);
  }
}

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse<ChannelMemberView[] | ApiErrorResponse>> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const limited = enforceRateLimit(
    'channel-members.write',
    session.user.id,
    RateLimits.WRITE,
  );
  if (limited) return limited;

  if (!(await assertChannelInWorkspace(params.channelId))) {
    return errorResponse('Channel not found in this workspace.', 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400);
  }
  const parsed = ADD_MEMBER_BODY.safeParse(body);
  if (!parsed.success) {
    return errorResponse('Field "userId" must be a non-empty string.', 400);
  }

  // The target user must belong to this workspace (audit H4 boundary).
  const target = await prisma.user.findFirst({
    where: { id: parsed.data.userId, workspaceId: resolveWorkspaceId() },
    select: { id: true },
  });
  if (!target) {
    return errorResponse('User not found in this workspace.', 404);
  }

  try {
    await ChannelService.addMember(params.channelId, parsed.data.userId);
    const members = await ChannelService.listMembers(params.channelId);
    return NextResponse.json<ChannelMemberView[]>(members, { status: 200 });
  } catch {
    return errorResponse('Failed to add member.', 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse<ChannelMemberView[] | ApiErrorResponse>> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const limited = enforceRateLimit(
    'channel-members.write',
    session.user.id,
    RateLimits.WRITE,
  );
  if (limited) return limited;

  if (!(await assertChannelInWorkspace(params.channelId))) {
    return errorResponse('Channel not found in this workspace.', 404);
  }

  const userId = new URL(request.url).searchParams.get('userId');
  if (userId === null || userId.length === 0) {
    return errorResponse(
      'Query parameter "userId" must be a non-empty string.',
      400,
    );
  }

  try {
    await ChannelService.removeMember(params.channelId, userId);
    const members = await ChannelService.listMembers(params.channelId);
    return NextResponse.json<ChannelMemberView[]>(members, { status: 200 });
  } catch {
    return errorResponse('Failed to remove member.', 500);
  }
}
