'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { KanbanBoard } from '@/components/board/KanbanBoard';
import type { TaskCardData } from '@/components/board/TaskCard';
import { NewTaskDialog } from '@/components/board/NewTaskDialog';
import { getClientSocket } from '@/lib/realtime/client';
import { EVENTS, type TaskUpdatedPayload } from '@/lib/realtime/events';
import { cn } from '@/lib/utils';

/**
 * Minimal projection of a `User` row used to label task assignees on
 * the kanban cards. The page resolves these on the server before
 * rendering so card footers don't have to fan out into separate
 * fetches per task.
 */
export interface BoardUser {
  id: string;
  name: string;
  isAI: boolean;
}

export interface BoardViewProps {
  /**
   * Tasks already projected from `Task` Prisma rows on the server.
   * Sorted oldest-first by `TaskService.list`.
   */
  initialTasks: readonly TaskCardData[];
  /**
   * Map of `userId → BoardUser` covering every assignee referenced
   * in `initialTasks` plus the seeded AI colleagues. Live
   * `task:updated` events use this to resolve assignee names without
   * extra round-trips.
   */
  knownUsers: Readonly<Record<string, BoardUser>>;
  /**
   * Plain `{id, name}` list of users the "New task" form lets you
   * pick from in the assignee dropdown. Excludes the current user
   * (you don't usually self-assign from the board) but includes both
   * AI colleagues so a human can hand work to Ada / Hopper.
   */
  assignableUsers: readonly BoardUser[];
}

/**
 * Translate a wire-format `TaskUpdatedPayload` into the
 * `TaskCardData` shape the kanban renders. Falls back gracefully
 * when an assignee id is unknown (extremely rare — would only
 * happen if a task was assigned to a user created after this page
 * loaded).
 */
function payloadToCard(
  payload: TaskUpdatedPayload,
  users: Readonly<Record<string, BoardUser>>,
): TaskCardData {
  const assigneeRow = payload.assigneeId
    ? users[payload.assigneeId]
    : undefined;
  return {
    id: payload.id,
    taskId: payload.taskId,
    title: payload.title,
    status: payload.status,
    // The data model does not carry `priority` yet (the AI tools and
    // form alike never set it). Default everything to "Medium" so the
    // card swatch stays consistent; a future Priority column on the
    // schema can replace this without touching the UI contract.
    priority: 'Medium',
    isAITask: payload.isAITask,
    assignee: assigneeRow
      ? {
          id: assigneeRow.id,
          name: assigneeRow.name,
          isAI: assigneeRow.isAI,
        }
      : payload.assigneeId
        ? { id: payload.assigneeId, name: payload.assigneeId, isAI: false }
        : null,
  };
}

/**
 * Client-side kanban board.
 *
 * Responsibilities:
 *   1. Render the four-column board from `initialTasks` (server-rendered
 *      so the first paint is immediate, no loading spinner).
 *   2. Subscribe to the workspace-wide `task:updated` Socket.io event
 *      so any task creation / status change — whether triggered by a
 *      human via {@link NewTaskDialog} or by an AI through the
 *      `create_task` / `update_task_status` tools — appears live
 *      without a refresh.
 *   3. Expose a "New task" button in the header that opens
 *      {@link NewTaskDialog}; on submit the dialog POSTs to
 *      `/api/tasks` and the realtime broadcast feeds the card back
 *      into the local list (a duplicate-id guard avoids double-render).
 */
export function BoardView({
  initialTasks,
  knownUsers,
  assignableUsers,
}: BoardViewProps): JSX.Element {
  const [tasks, setTasks] = useState<TaskCardData[]>(() => [...initialTasks]);
  const [isDialogOpen, setDialogOpen] = useState(false);

  // Maintain a mutable lookup so we can resolve `assigneeId → name` on
  // realtime payloads without re-deriving from the (potentially stale)
  // initial map. We write to it on every `task:updated` so a
  // newly-introduced AI / human shows up in subsequent labels too.
  const userMap = useMemo(
    () => ({ ...knownUsers }),
    [knownUsers],
  );

  useEffect(() => {
    const socket = getClientSocket();
    const handleTaskUpdated = (payload: TaskUpdatedPayload): void => {
      setTasks((prev) => {
        const card = payloadToCard(payload, userMap);
        const idx = prev.findIndex((t) => t.id === card.id);
        if (idx === -1) return [...prev, card];
        const copy = prev.slice();
        copy[idx] = card;
        return copy;
      });
    };
    socket.on(EVENTS.TaskUpdated, handleTaskUpdated);
    return () => {
      socket.off(EVENTS.TaskUpdated, handleTaskUpdated);
    };
  }, [userMap]);

  return (
    <div className="flex h-full w-full flex-col gap-6 px-8 py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Tasks
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            看板
          </h1>
          <p className="text-sm text-muted-foreground">
            Backlog · In Progress · In Review · Done。AI 创建/接手的任务带紫色 AI 徽章。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          data-testid="new-task-button"
          className={cn(
            'inline-flex h-10 shrink-0 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white shadow-sm transition-colors',
            'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40',
          )}
        >
          <Plus className="h-4 w-4" aria-hidden />
          新建任务
        </button>
      </header>

      <KanbanBoard tasks={tasks} className="min-h-0 flex-1" />

      {isDialogOpen ? (
        <NewTaskDialog
          assignableUsers={assignableUsers}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
