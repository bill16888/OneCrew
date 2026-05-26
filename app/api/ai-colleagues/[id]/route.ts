/**
 * `/api/ai-colleagues/[id]` route handlers.
 *
 * PATCH edits an AI colleague's display name, runtime settings, and
 * lifecycle status. DELETE is a soft delete that marks the AI inactive.
 */

import type { Prisma, User } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authOptions } from '@/lib/auth/options';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_WORKSPACE_ID = 'ws_default';

interface ApiErrorResponse {
  error: string;
}

interface RouteProps {
  params: { id: string };
}

const PATCH_AI_COLLEAGUE_BODY = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    systemPrompt: z.string().trim().max(12_000).optional(),
    toolSet: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    aiStatus: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.systemPrompt !== undefined ||
      value.toolSet !== undefined ||
      value.aiStatus !== undefined,
    { message: 'At least one editable field is required.' },
  );

type PatchAIColleagueBody = z.infer<typeof PATCH_AI_COLLEAGUE_BODY>;

function resolveWorkspaceId(): string {
  const fromEnv = process.env.WORKSPACE_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORKSPACE_ID;
}

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
  patch: Pick<PatchAIColleagueBody, 'systemPrompt' | 'toolSet'>,
): Prisma.InputJsonObject | undefined {
  if (patch.systemPrompt === undefined && patch.toolSet === undefined) {
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
    avatarUrl: currentRecord.avatarUrl ?? null,
  };
}

async function requireSession(): Promise<true | NextResponse<ApiErrorResponse>> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }
  return true;
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
  const session = await requireSession();
  if (session !== true) return session;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = PATCH_AI_COLLEAGUE_BODY.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json<ApiErrorResponse>(
      { error: formatZodError(parsed.error) },
      { status: 400 },
    );
  }

  const existing = await findAIColleague(params.id);
  if (!existing) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'AI colleague not found.' },
      { status: 404 },
    );
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
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to update AI colleague.' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteProps,
): Promise<NextResponse<User | ApiErrorResponse>> {
  const session = await requireSession();
  if (session !== true) return session;

  const existing = await findAIColleague(params.id);
  if (!existing) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'AI colleague not found.' },
      { status: 404 },
    );
  }

  try {
    const colleague = await prisma.user.update({
      where: { id: existing.id },
      data: { aiStatus: 'inactive' },
    });
    return NextResponse.json<User>(colleague, { status: 200 });
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to deactivate AI colleague.' },
      { status: 500 },
    );
  }
}
