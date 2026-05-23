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
