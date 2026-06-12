/**
 * `/api/ai-colleagues/[id]` route handlers.
 *
 * PATCH edits an AI colleague's display name, runtime settings, and
 * lifecycle status. DELETE is a soft delete that marks the AI inactive.
 */

import type { Prisma, User } from '@prisma/client';
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
import { resolveWorkspaceId } from '@/lib/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteProps {
  // Next.js 15: dynamic route `params` is asynchronous.
  params: Promise<{ id: string }>;
}

const PATCH_AI_COLLEAGUE_BODY = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    systemPrompt: z.string().trim().max(12_000).optional(),
    toolSet: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    /**
     * See the create handler — additional `@`-mention aliases for this
     * AI. Validated identically; `[]` clears all custom aliases while
     * leaving the seed aliases (Ada/Hopper) untouched.
     */
    mentionAliases: z
      .array(z.string().trim().min(1).max(80))
      .max(20)
      .optional(),
    aiStatus: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.systemPrompt !== undefined ||
      value.toolSet !== undefined ||
      value.mentionAliases !== undefined ||
      value.aiStatus !== undefined,
    { message: 'At least one editable field is required.' },
  );

type PatchAIColleagueBody = z.infer<typeof PATCH_AI_COLLEAGUE_BODY>;

function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid request body.';
  const path = issue.path.length > 0 ? issue.path.join('.') : '(body)';
  return `${path}: ${issue.message}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mergeAISettings(
  current: unknown,
  patch: Pick<
    PatchAIColleagueBody,
    'systemPrompt' | 'toolSet' | 'mentionAliases'
  >,
): Prisma.InputJsonObject | undefined {
  if (
    patch.systemPrompt === undefined &&
    patch.toolSet === undefined &&
    patch.mentionAliases === undefined
  ) {
    return undefined;
  }

  const currentRecord = asRecord(current);
  return {
    systemPrompt:
      patch.systemPrompt !== undefined
        ? patch.systemPrompt || null
        : currentRecord.systemPrompt ?? null,
    toolSet:
      patch.toolSet !== undefined
        ? patch.toolSet
        : Array.isArray(currentRecord.toolSet)
          ? currentRecord.toolSet
          : [],
    mentionAliases:
      patch.mentionAliases !== undefined
        ? patch.mentionAliases
        : Array.isArray(currentRecord.mentionAliases)
          ? currentRecord.mentionAliases
          : [],
    avatarUrl: currentRecord.avatarUrl ?? null,
  };
}

async function requireAuthenticatedSession() {
  return requireSession();
}

async function findAIColleague(id: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: {
      id,
      workspaceId: resolveWorkspaceId(),
      isAI: true,
    },
  });
}

export async function PATCH(
  request: Request,
  { params }: RouteProps,
): Promise<NextResponse<User | ApiErrorResponse>> {
  const session = await requireAuthenticatedSession();
  if (session instanceof NextResponse) return session;

  const limited = enforceRateLimit(
    'ai-colleagues.write',
    session.user.id,
    RateLimits.WRITE,
  );
  if (limited) return limited;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse('Request body must be valid JSON.', 400);
  }

  const parsed = PATCH_AI_COLLEAGUE_BODY.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(formatZodError(parsed.error), 400);
  }

  const { id } = await params;
  const existing = await findAIColleague(id);
  if (!existing) {
    return errorResponse('AI colleague not found.', 404);
  }

  const aiSettings = mergeAISettings(existing.aiSettings, parsed.data);
  try {
    const colleague = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.aiStatus !== undefined
          ? { aiStatus: parsed.data.aiStatus }
          : {}),
        ...(aiSettings !== undefined ? { aiSettings } : {}),
      },
    });
    return NextResponse.json<User>(colleague, { status: 200 });
  } catch {
    return errorResponse('Failed to update AI colleague.', 500);
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteProps,
): Promise<NextResponse<User | ApiErrorResponse>> {
  const session = await requireAuthenticatedSession();
  if (session instanceof NextResponse) return session;

  const limited = enforceRateLimit(
    'ai-colleagues.write',
    session.user.id,
    RateLimits.WRITE,
  );
  if (limited) return limited;

  const existing = await findAIColleague(params.id);
  if (!existing) {
    return errorResponse('AI colleague not found.', 404);
  }

  try {
    const colleague = await prisma.user.update({
      where: { id: existing.id },
      data: { aiStatus: 'inactive' },
    });
    return NextResponse.json<User>(colleague, { status: 200 });
  } catch {
    return errorResponse('Failed to deactivate AI colleague.', 500);
  }
}
