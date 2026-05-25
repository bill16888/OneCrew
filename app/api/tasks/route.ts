/**
 * GET `/api/tasks` route handler.
 *
 * Returns every task in the active workspace so the Kanban board page
 * can render the four-column layout. Reads are funneled through
 * {@link TaskService.list}, which orders rows by `createdAt` ascending.
 *
 * Contract:
 *   - Method: `GET`
 *   - Auth: requires a valid NextAuth session. No session ⇒
 *     `401 { error }`.
 *   - Responses:
 *     - `200 Task[]` on success — the persisted Prisma rows JSON-encoded.
 *       `Date` fields (`createdAt`, `updatedAt`) are serialized as ISO
 *       8601 strings automatically by `NextResponse.json` /
 *       `JSON.stringify`.
 *     - `401 { error }` when the request has no NextAuth session.
 *     - `500 { error }` for unexpected persistence failures.
 *
 * No realtime broadcast happens here — this route is read-only. Writes
 * (with their `task:updated` emissions) live in `lib/services/task.service.ts`
 * and are exposed through the AI tool dispatcher.
 *
 * Validates: Requirements 3.1, 3.7.
 *
 * @module app/api/tasks/route
 */

import type { Task } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authOptions } from '@/lib/auth/options';
import { TaskService } from '@/lib/services/task.service';

/** Always run this route on the Node.js runtime (Prisma needs Node APIs). */
export const runtime = 'nodejs';
/** Disable static optimization — the response is session-bound. */
export const dynamic = 'force-dynamic';

/**
 * Error envelope returned for every non-2xx response. Matches the shape
 * used by the sibling `POST /api/messages` route so clients can treat
 * `{ error: string }` as the universal API error contract.
 */
interface ApiErrorResponse {
  error: string;
}

/**
 * Handle `GET /api/tasks`. See module docs for the full contract.
 *
 * @returns A `NextResponse` carrying either the workspace's task list
 *   (`200`) or an {@link ApiErrorResponse} (`401` / `500`).
 */
export async function GET(): Promise<
  NextResponse<Task[] | ApiErrorResponse>
> {
  // 1. Auth gate. Without a session we refuse to disclose any task data.
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  // 2. Delegate to the service layer. Date fields on the returned rows
  //    are serialized to ISO 8601 strings by NextResponse.json, which
  //    matches what the kanban page expects on the client.
  try {
    const tasks = await TaskService.list();
    return NextResponse.json<Task[]>(tasks, { status: 200 });
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to load tasks.' },
      { status: 500 },
    );
  }
}

/**
 * Zod schema for `POST /api/tasks` request bodies.
 *
 * Mirrors the limits we apply to the AI tool surface in
 * `TOOL_ZOD_SCHEMAS.create_task` so a human-driven submission cannot
 * write a row the AI couldn't produce on its own. `assigneeId` stays
 * optional — the kanban "New task" form lets users leave it unassigned.
 */
const CREATE_TASK_BODY = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  assigneeId: z.string().min(1).optional(),
});

/**
 * Handle `POST /api/tasks`. Lets a signed-in *human* user create a task
 * directly from the UI (the Kanban "New task" button). The AI runtime
 * still uses its own dispatcher path via the `create_task` tool — this
 * route exists strictly for the human-driven flow.
 *
 * Contract:
 *   - Method: `POST`
 *   - Auth: requires a valid NextAuth session.
 *   - Body: `{ title: string, description?: string, assigneeId?: string }`
 *   - Responses:
 *     - `201 Task` on success.
 *     - `400 { error }` when the JSON body is malformed or fails Zod.
 *     - `401 { error }` when the request has no NextAuth session.
 *     - `500 { error }` for unexpected persistence failures.
 *
 * The realtime broadcast (`task:updated`) is emitted by
 * `TaskService.create` after the row commits, so every connected client
 * sees the new task automatically — no extra plumbing needed here.
 */
export async function POST(
  request: Request,
): Promise<NextResponse<Task | ApiErrorResponse>> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  // Parse + validate the JSON body. Treat any parse / schema failure as
  // a 400 so the client can surface a friendly error message in the
  // form. We don't expose Zod's full error tree on the wire — a single
  // human-readable line keeps the API contract narrow.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Invalid JSON body.' },
      { status: 400 },
    );
  }
  const parsed = CREATE_TASK_BODY.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') || '(body)';
    return NextResponse.json<ApiErrorResponse>(
      { error: `Invalid ${path}: ${first?.message ?? 'unknown error'}` },
      { status: 400 },
    );
  }

  try {
    const task = await TaskService.create({
      title: parsed.data.title,
      description: parsed.data.description,
      creatorId: session.user.id,
      assigneeId: parsed.data.assigneeId,
    });
    return NextResponse.json<Task>(task, { status: 201 });
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to create task.' },
      { status: 500 },
    );
  }
}
