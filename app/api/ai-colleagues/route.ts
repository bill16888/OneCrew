/**
 * `/api/ai-colleagues` route handlers.
 *
 * GET lists every AI colleague in the active workspace. POST creates a
 * new AI user with no password, so the Credentials provider can never
 * authenticate as that AI.
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

const CREATE_AI_COLLEAGUE_BODY = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254),
    systemPrompt: z.string().trim().max(12_000).optional(),
    toolSet: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  })
  .strict();

type CreateAIColleagueBody = z.infer<typeof CREATE_AI_COLLEAGUE_BODY>;

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

function buildAISettings(
  input: Pick<CreateAIColleagueBody, 'name' | 'systemPrompt' | 'toolSet'>,
): Prisma.InputJsonObject {
  return {
    systemPrompt:
      input.systemPrompt && input.systemPrompt.length > 0
        ? input.systemPrompt
        : [
            `You are ${input.name}, an AI teammate in AI-Native Team Workspace.`,
            'Collaborate with human teammates through channels, tasks, and approvals.',
            'Always write user-facing messages in Simplified Chinese.',
            'For production changes, external communication, destructive actions, or other high-risk work, call request_approval before taking action.',
          ].join('\n'),
    toolSet: input.toolSet ?? [],
    avatarUrl: null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
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

export async function GET(): Promise<
  NextResponse<User[] | ApiErrorResponse>
> {
  const session = await requireSession();
  if (session !== true) return session;

  try {
    const colleagues = await prisma.user.findMany({
      where: { workspaceId: resolveWorkspaceId(), isAI: true },
      orderBy: [{ aiStatus: 'asc' }, { name: 'asc' }],
    });
    return NextResponse.json<User[]>(colleagues, { status: 200 });
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to load AI colleagues.' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
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

  const parsed = CREATE_AI_COLLEAGUE_BODY.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json<ApiErrorResponse>(
      { error: formatZodError(parsed.error) },
      { status: 400 },
    );
  }

  try {
    const colleague = await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash: null,
        isAI: true,
        aiRole: null,
        aiSettings: buildAISettings(parsed.data),
        aiStatus: 'active',
        workspaceId: resolveWorkspaceId(),
      },
    });
    return NextResponse.json<User>(colleague, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json<ApiErrorResponse>(
        { error: 'Email is already in use.' },
        { status: 409 },
      );
    }
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to create AI colleague.' },
      { status: 500 },
    );
  }
}
