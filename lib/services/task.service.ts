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

import prisma from '@/lib/prisma';
import { EVENTS, type TaskUpdatedPayload } from '@/lib/realtime/events';
import { getIO } from '@/lib/realtime/io';

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
 * Default workspace identifier used when `process.env.WORKSPACE_ID` is unset.
 * Mirrors the single-workspace MVP assumption (requirements.md §1.7) and is
 * kept aligned with `lib/realtime/io.ts` and `prisma/seed.ts`.
 */
const DEFAULT_WORKSPACE_ID = 'ws_default';

/**
 * Resolve the active workspace id from the environment, falling back to
 * {@link DEFAULT_WORKSPACE_ID}. Read lazily (per call) so test harnesses
 * can mutate `process.env.WORKSPACE_ID` between invocations.
 */
function resolveWorkspaceId(): string {
  const fromEnv = process.env.WORKSPACE_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORKSPACE_ID;
}

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

/**
 * Aggregated namespace export so callers can use either named imports
 * or the `TaskService.method(...)` style favored across the spec.
 */
export const TaskService = {
  create,
  updateStatus,
  list,
} as const;
