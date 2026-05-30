/**
 * Task service.
 *
 * Owns the write-side and read-side logic for the Kanban board:
 *   - {@link create}: persists a new {@link Task} inside a Prisma transaction
 *     while atomically incrementing `Workspace.taskCounter`, then broadcasts
 *     `task:updated` after a successful commit.
 *   - {@link updateStatus}: validates the candidate status against the
 *     fixed 4-column value set and broadcasts `task:updated` on success.
 *   - {@link list}: returns every task in the workspace ordered by
 *     `createdAt` ascending.
 *
 * The realtime broadcast is **only** emitted after the database write
 * commits. Persistence failures rethrow the original error and emit
 * nothing — see Requirements 8.5 / 10.4.
 *
 * Reference:
 * - design.md → "Task ID (PROJ-{N} 单调递增)" / "Components and Interfaces"
 * - requirements.md → Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 5.5, 5.6, 8.5, 10.4
 *
 * @module lib/services/task.service
 */

import type { Task } from '@prisma/client';

import { notifyTaskDone } from '@/lib/notifications/server';
import prisma from '@/lib/prisma';
import { EVENTS, type TaskUpdatedPayload } from '@/lib/realtime/events';
import { getIO } from '@/lib/realtime/io';
import { resolveWorkspaceId } from '@/lib/workspace';

/**
 * The four allowed Kanban columns. Matches the Prisma `TaskStatus` enum
 * 1:1 and the `TaskStatusName` union from `lib/realtime/events.ts`.
 *
 * Validates: Requirements 3.1, 3.4, 5.6.
 */
export const TASK_STATUSES = [
  'Backlog',
  'InProgress',
  'InReview',
  'Done',
] as const;

/**
 * Union of valid Task status values.
 */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Validation error raised when a caller passes an invalid status to
 * {@link updateStatus}. Kept as a local class so the service does not
 * depend on a generic error utility module that does not yet exist.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Type guard verifying that `value` is one of the four allowed
 * {@link TASK_STATUSES} entries.
 */
function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Convert a persisted {@link Task} row into the wire payload used by the
 * `task:updated` realtime event. Dates are serialized as ISO 8601 strings
 * because Socket.io broadcasts JSON over the wire.
 */
function toTaskUpdatedPayload(task: Task): TaskUpdatedPayload {
  return {
    id: task.id,
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    status: task.status,
    isAITask: task.isAITask,
    creatorId: task.creatorId,
    assigneeId: task.assigneeId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/**
 * Broadcast a `task:updated` event to the workspace room. No-ops when the
 * Socket.io server has not been initialized yet (e.g. during unit tests
 * or before `server.ts` wires the realtime layer).
 *
 * Callers MUST only invoke this after a successful database commit so
 * that we never broadcast an un-persisted snapshot (Requirements 10.4).
 */
function broadcastTaskUpdated(task: Task): void {
  const io = getIO();
  if (!io) return;
  const room = `workspace:${resolveWorkspaceId()}`;
  io.to(room).emit(EVENTS.TaskUpdated, toTaskUpdatedPayload(task));
}

/**
 * Input accepted by {@link create}.
 */
export interface CreateTaskInput {
  /** Human-visible title (required, must be a non-empty string). */
  title: string;
  /** Optional long-form description. */
  description?: string;
  /** User id of the task creator. May be a human or AI colleague. */
  creatorId: string;
  /** Optional assignee user id. May be a human or AI colleague. */
  assigneeId?: string;
}

/**
 * Create a new task on the Kanban board.
 *
 * Inside a single Prisma transaction the implementation:
 *   1. Atomically increments `Workspace.taskCounter` and reads back the
 *      new value `N`. PostgreSQL takes a row-level lock on the workspace
 *      row during the `UPDATE … RETURNING`, so concurrent calls observe
 *      a strictly monotonic counter and yield distinct `PROJ-{N}` ids.
 *   2. Looks up the creator (and optional assignee) to derive
 *      `isAITask = creator.isAI || (assignee?.isAI ?? false)`.
 *   3. Inserts the {@link Task} row with `status = 'Backlog'`.
 *
 * Only after the transaction commits does this method broadcast the
 * `task:updated` event. If any step throws, the transaction rolls back,
 * the original error is re-thrown to the caller, and nothing is emitted.
 *
 * Validates: Requirements 3.2, 3.3, 3.5, 3.6, 5.5, 8.5, 10.4.
 *
 * @param input - {@link CreateTaskInput} describing the new task.
 * @returns The persisted {@link Task} record (with the newly minted
 *   `taskId` of the form `PROJ-{N}`).
 * @throws The original Prisma error when persistence fails. The realtime
 *   layer is not invoked in that case.
 *
 * @example
 * ```ts
 * const task = await TaskService.create({
 *   title: 'Wire up Kanban board',
 *   creatorId: humanUser.id,
 *   assigneeId: aiAda.id,
 * });
 * // task.taskId === 'PROJ-7' (next sequential id for the workspace)
 * // task.status === 'Backlog'
 * // task.isAITask === true (because the assignee is an AI colleague)
 * ```
 */
export async function create(input: CreateTaskInput): Promise<Task> {
  const workspaceId = resolveWorkspaceId();

  const task = await prisma.$transaction(async (tx) => {
    // 1) Atomically bump the workspace's task counter and capture N.
    const updatedWorkspace = await tx.workspace.update({
      where: { id: workspaceId },
      data: { taskCounter: { increment: 1 } },
      select: { taskCounter: true },
    });
    const taskId = `PROJ-${updatedWorkspace.taskCounter}`;

    // 2) Look up creator and (optional) assignee to derive isAITask.
    const creator = await tx.user.findUniqueOrThrow({
      where: { id: input.creatorId },
      select: { id: true, isAI: true },
    });
    const assignee = input.assigneeId
      ? await tx.user.findUnique({
          where: { id: input.assigneeId },
          select: { id: true, isAI: true },
        })
      : null;
    const isAITask = creator.isAI || (assignee?.isAI ?? false);

    // 3) Insert the Task row. status defaults to 'Backlog' on the schema,
    //    but we set it explicitly to keep the contract obvious.
    return tx.task.create({
      data: {
        taskId,
        title: input.title,
        description: input.description,
        status: 'Backlog',
        isAITask,
        workspaceId,
        creatorId: creator.id,
        assigneeId: assignee?.id,
      },
    });
  });

  // Persistence committed — safe to broadcast.
  broadcastTaskUpdated(task);
  return task;
}

/**
 * Move a task to a new status column.
 *
 * The candidate `status` is validated against {@link TASK_STATUSES}
 * before any database mutation; values outside the four-element set
 * raise a {@link ValidationError} and the underlying row is left
 * untouched (no broadcast occurs).
 *
 * `taskId` here refers to the human-readable `Task.taskId` field
 * (e.g. `'PROJ-7'`), not the internal cuid `id`. This matches the value
 * exposed to AI tools and to the UI.
 *
 * Validates: Requirements 3.4, 3.5, 5.6, 8.5, 10.4.
 *
 * @param taskId - The human-readable `PROJ-{N}` identifier of the task.
 * @param status - Candidate status value. Accepted as a plain `string` so
 *   that callers from untyped layers (HTTP route handlers, AI tool
 *   dispatcher) can hand the raw input through without a pre-cast; the
 *   runtime guard below is the source of truth.
 * @returns The updated {@link Task} record.
 * @throws {ValidationError} when `status` is not in {@link TASK_STATUSES}.
 * @throws The original Prisma error when persistence fails (e.g. the
 *   task does not exist). The realtime layer is not invoked in that case.
 *
 * @example
 * ```ts
 * const moved = await TaskService.updateStatus('PROJ-7', 'InProgress');
 * ```
 */
export async function updateStatus(
  taskId: string,
  status: string,
): Promise<Task> {
  if (!isTaskStatus(status)) {
    throw new ValidationError(
      `Invalid task status: ${String(status)}. Expected one of ${TASK_STATUSES.join(', ')}.`,
    );
  }

  const workspaceId = resolveWorkspaceId();

  // Scope the lookup by `workspaceId` so a caller from a different
  // workspace cannot move tasks they do not own. The MVP has a single
  // workspace today, but baking this guard in now means the multi-
  // workspace migration is just a matter of switching `resolveWorkspaceId()`
  // to the session's workspace, with no service-layer changes
  // (audit finding H4).
  const existing = await prisma.task.findFirst({
    where: { taskId, workspaceId },
    select: { id: true },
  });
  if (!existing) {
    throw new ValidationError(
      `Task ${taskId} does not exist in this workspace.`,
    );
  }

  const task = await prisma.task.update({
    where: { id: existing.id },
    data: { status },
  });

  broadcastTaskUpdated(task);

  // Notify the operator when a task reaches Done (Phase 1 Req 18.2).
  // Best-effort, post-commit; no-ops when no IO server is wired.
  if (task.status === 'Done') {
    notifyTaskDone(task.taskId, task.title);
  }

  return task;
}

/**
 * Return every task in the active workspace, ordered by `createdAt`
 * ascending so the UI can render them in creation order.
 *
 * Used by the Kanban board page and `/api/tasks` GET handler.
 *
 * @returns Tasks belonging to the active workspace, oldest first.
 *   Returns an empty array when no tasks exist yet.
 *
 * @example
 * ```ts
 * const tasks = await TaskService.list();
 * ```
 */
export async function list(): Promise<Task[]> {
  return prisma.task.findMany({
    where: { workspaceId: resolveWorkspaceId() },
    orderBy: { createdAt: 'asc' },
  });
}

// ---------------------------------------------------------------------------
// Teammate task summary (direction D, Req 20 — check_teammate_tasks)
// ---------------------------------------------------------------------------

/**
 * Lookback window (ms) used by {@link summarizeForAI} to decide which
 * tasks count as "recently updated". 24 hours per Req 20.3.
 */
const RECENT_TASK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on how many recently-updated task titles {@link summarizeForAI}
 * returns, so a prolific AI cannot blow up the model's context budget
 * when a teammate inspects it.
 */
const RECENT_TASK_LIMIT = 20;

/**
 * One recently-touched task in a {@link TeammateTaskSummary}.
 */
export interface RecentTeammateTask {
  /** Human-readable `PROJ-{N}` identifier. */
  readonly taskId: string;
  /** Task title. */
  readonly title: string;
  /** Current column. */
  readonly status: TaskStatus;
}

/**
 * Read-only summary of a single AI colleague's task load, returned by
 * the `check_teammate_tasks` tool (direction D, Req 20). Carries counts
 * by status and the titles of tasks updated in the last 24h. No side
 * effects — this is a pure read.
 */
export interface TeammateTaskSummary {
  /** Count of the AI's tasks in each of the four columns. */
  readonly counts: Record<TaskStatus, number>;
  /** Total number of tasks created by OR assigned to the AI. */
  readonly total: number;
  /** Tasks updated within the last {@link RECENT_TASK_WINDOW_MS}. */
  readonly recentlyUpdated: readonly RecentTeammateTask[];
}

/**
 * Resolve a teammate AI by id or name within the active workspace.
 *
 * The `check_teammate_tasks` tool lets one AI inspect another by either
 * the target's `User.id` (`aiUserId`) or its display `name`
 * (`aiName`). This helper performs the workspace-scoped lookup so the
 * dispatcher never reads Prisma directly and the resolution stays
 * testable behind a service mock.
 *
 * Resolution order: try `aiUserId` first (exact id match), then
 * `aiName` (case-insensitive equality). Only users with `isAI === true`
 * in the active workspace are eligible — a human's name can never
 * resolve here. Returns `null` when nothing matches; callers translate
 * that into an `is_error` tool_result.
 *
 * Read-only: no writes, no broadcasts, no wakes (Req 20.3).
 *
 * @param selector At least one of `aiUserId` / `aiName` (the tool's
 *   Zod schema enforces "at least one present" before this runs).
 * @returns The resolved teammate's `{ id, name }`, or `null`.
 */
export async function resolveTeammate(selector: {
  aiUserId?: string;
  aiName?: string;
}): Promise<{ id: string; name: string } | null> {
  const workspaceId = resolveWorkspaceId();
  const aiUserId = selector.aiUserId?.trim();
  const aiName = selector.aiName?.trim();

  if (aiUserId) {
    const byId = await prisma.user.findFirst({
      where: { id: aiUserId, isAI: true, workspaceId },
      select: { id: true, name: true },
    });
    if (byId) return byId;
  }

  if (aiName) {
    const byName = await prisma.user.findFirst({
      where: {
        name: { equals: aiName, mode: 'insensitive' },
        isAI: true,
        workspaceId,
      },
      select: { id: true, name: true },
    });
    if (byName) return byName;
  }

  return null;
}

/**
 * Summarise a teammate AI's task load (direction D, Req 20.3).
 *
 * Counts every task the AI either created or is assigned to, grouped by
 * the four Kanban columns, and returns the titles of those updated in
 * the last 24h (capped at {@link RECENT_TASK_LIMIT}, newest first).
 *
 * Scoped by `workspaceId` (audit H4) so a future multi-workspace
 * migration cannot let one workspace inspect another's tasks. Pure
 * read: no writes, no broadcasts, no wakes.
 *
 * @param aiUserId `User.id` of the teammate AI (already resolved via
 *   {@link resolveTeammate}).
 * @returns A {@link TeammateTaskSummary}.
 */
export async function summarizeForAI(
  aiUserId: string,
): Promise<TeammateTaskSummary> {
  const workspaceId = resolveWorkspaceId();

  const tasks = await prisma.task.findMany({
    where: {
      workspaceId,
      OR: [{ creatorId: aiUserId }, { assigneeId: aiUserId }],
    },
    select: { taskId: true, title: true, status: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });

  const counts = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, 0]),
  ) as Record<TaskStatus, number>;
  for (const task of tasks) {
    counts[task.status as TaskStatus] += 1;
  }

  const cutoff = Date.now() - RECENT_TASK_WINDOW_MS;
  const recentlyUpdated: RecentTeammateTask[] = tasks
    .filter((task) => task.updatedAt.getTime() >= cutoff)
    .slice(0, RECENT_TASK_LIMIT)
    .map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status as TaskStatus,
    }));

  return { counts, total: tasks.length, recentlyUpdated };
}

/**
 * Aggregated namespace export so callers can use either named imports
 * or the `TaskService.method(...)` style favored across the spec.
 */
export const TaskService = {
  create,
  updateStatus,
  list,
  resolveTeammate,
  summarizeForAI,
} as const;
