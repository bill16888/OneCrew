import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';

import { BoardView, type BoardUser } from '@/components/board/BoardView';
import type { TaskCardData } from '@/components/board/TaskCard';
import { authOptions } from '@/lib/auth/options';
import prisma from '@/lib/prisma';
import { TaskService } from '@/lib/services/task.service';

/**
 * `/board` — kanban view inside the `(workspace)` route group.
 *
 * Server-side responsibilities:
 *   1. Auth gate. Anonymous visitors are bounced to `/login`.
 *   2. Fetch every task in the workspace via `TaskService.list` (orders
 *      by `createdAt` ascending).
 *   3. Resolve every assignee in a single round-trip so the kanban
 *      cards can render names + AI flags without follow-up requests.
 *   4. Build the assignable-user list (everyone except the current user
 *      plus both AI colleagues) for the "New task" dropdown.
 *   5. Hand the projected data to the client {@link BoardView}, which
 *      subscribes to `task:updated` and exposes a "New task" button.
 */
export const dynamic = 'force-dynamic';

interface UserRow {
  id: string;
  name: string;
  isAI: boolean;
}

/**
 * Translate a Prisma `Task` row into the {@link TaskCardData} shape the
 * kanban cards expect. Mirrors `payloadToCard` in `BoardView` so the
 * server-rendered first paint and the live realtime updates produce
 * structurally identical cards.
 */
function rowToCard(
  task: {
    id: string;
    taskId: string;
    title: string;
    status: string;
    isAITask: boolean;
    assigneeId: string | null;
  },
  userMap: Map<string, UserRow>,
): TaskCardData {
  const assignee = task.assigneeId ? userMap.get(task.assigneeId) : null;
  return {
    id: task.id,
    taskId: task.taskId,
    title: task.title,
    // The Prisma `TaskStatus` enum values match the literal union the
    // kanban consumes (Backlog | InProgress | InReview | Done).
    status: task.status as TaskCardData['status'],
    priority: 'Medium',
    isAITask: task.isAITask,
    assignee: assignee
      ? { id: assignee.id, name: assignee.name, isAI: assignee.isAI }
      : task.assigneeId
        ? { id: task.assigneeId, name: task.assigneeId, isAI: false }
        : null,
  };
}

export default async function BoardPage(): Promise<JSX.Element> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect('/login');
  }
  const currentUserId = session.user.id;

  // 1. Load tasks + every workspace user in parallel. Loading users
  //    eagerly (as opposed to per-task lookup) keeps the request to
  //    one round-trip total.
  const [tasks, allUsers] = await Promise.all([
    TaskService.list(),
    prisma.user.findMany({
      select: { id: true, name: true, isAI: true },
      orderBy: [{ isAI: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const userMap = new Map<string, UserRow>(allUsers.map((u) => [u.id, u]));
  const initialTasks = tasks.map((t) => rowToCard(t, userMap));

  // 2. Build the assignee dropdown options. Include everyone except
  //    the current user (you usually create tasks *for someone else*),
  //    but keep both AI colleagues so a human can hand work to them.
  const knownUsers: Record<string, BoardUser> = Object.fromEntries(
    allUsers.map((u) => [u.id, u]),
  );
  const assignableUsers = allUsers.filter((u) => u.id !== currentUserId);

  return (
    <BoardView
      initialTasks={initialTasks}
      knownUsers={knownUsers}
      assignableUsers={assignableUsers}
    />
  );
}
