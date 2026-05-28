/**
 * `/api/ai-colleagues` route handlers.
 *
 * GET lists every AI colleague in the active workspace. POST creates a
 * new AI user with no password, so the Credentials provider can never
 * authenticate as that AI.
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_WORKSPACE_ID = 'ws_default';

const CREATE_AI_COLLEAGUE_BODY = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254),
    systemPrompt: z.string().trim().max(12_000).optional(),
    toolSet: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    /**
     * Additional `@`-mention aliases this AI should respond to. Each
     * entry is matched case-insensitively against the bare name after
     * the `@` sigil. Useful for Chinese / nickname forms of an AI's
     * English name (e.g. `["小林", "lin"]`). Maps to
     * `aiSettings.mentionAliases` and is consumed by
     * `MessageService.wakeMentionedAIs`.
     */
    mentionAliases: z
      .array(z.string().trim().min(1).max(80))
      .max(20)
      .optional(),
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
  input: Pick<
    CreateAIColleagueBody,
    'name' | 'systemPrompt' | 'toolSet' | 'mentionAliases'
  >,
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
    mentionAliases: input.mentionAliases ?? [],
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

async function requireAuthenticatedSession() {
  return requireSession();
}

export async function GET(): Promise<
  NextResponse<User[] | ApiErrorResponse>
> {
  const session = await requireAuthenticatedSession();
  if (session instanceof NextResponse) return session;

  try {
    const colleagues = await prisma.user.findMany({
      where: { workspaceId: resolveWorkspaceId(), isAI: true },
      orderBy: [{ aiStatus: 'asc' }, { name: 'asc' }],
    });
    return NextResponse.json<User[]>(colleagues, { status: 200 });
  } catch {
    return errorResponse('Failed to load AI colleagues.', 500);
  }
}

export async function POST(
  request: Request,
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

  const parsed = CREATE_AI_COLLEAGUE_BODY.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(formatZodError(parsed.error), 400);
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
      return errorResponse('Email is already in use.', 409);
    }
    return errorResponse('Failed to create AI colleague.', 500);
  }
}
