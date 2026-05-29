/**
 * `/api/channels/[channelId]/knowledge` — channel knowledge card
 * (Req 19.3, 19.4).
 *
 *   - GET → `{ content: string | null }`
 *   - PUT body `{ content: string }` → `{ content }` (empty clears)
 *
 * Both require a session and enforce the workspace boundary (audit
 * H4). PUT is rate-limited and caps content at 8,000 chars.
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
  KNOWLEDGE_MAX_LENGTH,
  KnowledgeValidationError,
} from '@/lib/services/channel.service';
import { resolveWorkspaceId } from '@/lib/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { channelId: string };
}

interface KnowledgeResponse {
  content: string | null;
}

const PUT_BODY = z.object({
  content: z.string().max(KNOWLEDGE_MAX_LENGTH),
});

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
): Promise<NextResponse<KnowledgeResponse | ApiErrorResponse>> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  if (!(await assertChannelInWorkspace(params.channelId))) {
    return errorResponse('Channel not found in this workspace.', 404);
  }

  try {
    const content = await ChannelService.getKnowledge(params.channelId);
    return NextResponse.json<KnowledgeResponse>({ content }, { status: 200 });
  } catch {
    return errorResponse('Failed to load channel knowledge.', 500);
  }
}

export async function PUT(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse<KnowledgeResponse | ApiErrorResponse>> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const limited = enforceRateLimit(
    'channel-knowledge.write',
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
  const parsed = PUT_BODY.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      `Field "content" must be a string of at most ${KNOWLEDGE_MAX_LENGTH} characters.`,
      400,
    );
  }

  try {
    await ChannelService.setKnowledge(params.channelId, parsed.data.content);
    return NextResponse.json<KnowledgeResponse>(
      { content: parsed.data.content },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof KnowledgeValidationError) {
      return errorResponse(err.message, 400);
    }
    return errorResponse('Failed to save channel knowledge.', 500);
  }
}
