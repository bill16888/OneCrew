/**
 * Approval service.
 *
 * Owns the write-side and read-side logic for human-in-the-loop approval
 * gating of AI actions:
 *   - {@link create}: persists a new {@link Approval} row with
 *     `status = 'PENDING'`, then broadcasts `approval:created` to the
 *     workspace room.
 *   - {@link approve}: transitions a row `PENDING → APPROVED`, then emits
 *     `wakeup` on the {@link agenticEmitter} so the Agentic Loop can
 *     resume the requesting AI without waiting for the next 30 s tick.
 *   - {@link reject}: transitions a row `PENDING → REJECTED`, then emits
 *     `reject` on the {@link agenticEmitter} so the AI Runtime can
 *     terminate the in-flight cycle. **No `wakeup` is emitted** on
 *     rejection.
 *   - {@link listPendingForAI}: returns every still-pending approval for
 *     a single AI colleague — used by the Agentic Loop as the gating
 *     predicate before starting a new cycle.
 *   - {@link isStale}: pure helper deciding whether a PENDING approval
 *     has been waiting longer than 24 h.
 *
 * The realtime broadcast is **only** emitted after the database write
 * commits. Persistence failures rethrow the original error and emit
 * nothing — see Requirements 8.6 / 10.4.
 *
 * Reference:
 * - design.md → "Components and Interfaces" / "Agentic Loop"
 * - requirements.md → Requirements 5.8, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7,
 *   8.6, 10.4
 *
 * @module lib/services/approval.service
 */

import type { Approval, Prisma } from '@prisma/client';

import { agenticEmitter } from '@/lib/loop/emitter';
import prisma from '@/lib/prisma';
import {
  EVENTS,
  type ApprovalCreatedPayload,
} from '@/lib/realtime/events';
import { getIO } from '@/lib/realtime/io';

/**
 * Default workspace identifier used when `process.env.WORKSPACE_ID` is unset.
 * Mirrors the single-workspace MVP assumption (requirements.md §1.7) and is
 * kept aligned with `lib/realtime/io.ts`, `lib/services/task.service.ts`
 * and `prisma/seed.ts`.
 */
const DEFAULT_WORKSPACE_ID = 'ws_default';

/**
 * Threshold for {@link isStale}: an approval is considered stale once it
 * has been `PENDING` for longer than this many milliseconds. 24 h matches
 * Requirements 6.7.
 */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the active workspace id from the validated environment, falling
 * back to {@link DEFAULT_WORKSPACE_ID}. We intentionally read `process.env`
 * lazily here (instead of caching `env.WORKSPACE_ID`) so test harnesses
 * can mutate `process.env.WORKSPACE_ID` between invocations, matching the
 * pattern used in `lib/realtime/io.ts`.
 */
function resolveWorkspaceId(): string {
  const fromEnv = process.env.WORKSPACE_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORKSPACE_ID;
}

/**
 * Coerce a persisted Prisma JSON value into the wire shape accepted by
 * {@link ApprovalCreatedPayload.payload} (`Record<string, unknown> | null`).
 *
 * Prisma stores `Approval.payload` as `Json`, which means reads can yield
 * any JSON value (object, array, string, number, boolean, null). The
 * realtime payload contract narrows this to "object or null"; non-object
 * values (including arrays) are flattened to `null` so consumers always
 * get a keyed structure or no metadata at all. Mirrors the helper used in
 * {@link MessageService} for `Message.metadata`.
 */
function toPayloadField(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> | null {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Build the wire payload for an `approval:created` event from a persisted
 * {@link Approval} row. Dates are serialized as ISO 8601 strings because
 * Socket.io broadcasts JSON over the wire.
 */
function toApprovalCreatedPayload(
  approval: Approval,
): ApprovalCreatedPayload {
  return {
    id: approval.id,
    aiUserId: approval.aiUserId,
    action: approval.action,
    payload: toPayloadField(approval.payload),
    status: approval.status,
    createdAt: approval.createdAt.toISOString(),
  };
}

/**
 * Broadcast an `approval:created` event to the workspace room. No-ops
 * when the Socket.io server has not been initialized yet (e.g. during
 * unit tests or before `server.ts` wires the realtime layer).
 *
 * Callers MUST only invoke this after a successful database commit so
 * that we never broadcast an un-persisted approval (Requirements 8.6 /
 * 10.4).
 */
function broadcastApprovalCreated(approval: Approval): void {
  const io = getIO();
  if (!io) return;
  const room = `workspace:${resolveWorkspaceId()}`;
  io.to(room).emit(EVENTS.ApprovalCreated, toApprovalCreatedPayload(approval));
}

/**
 * Input accepted by {@link create}.
 */
export interface CreateApprovalInput {
  /** The AI colleague (`User.id`) on whose behalf the approval is requested. */
  aiUserId: string;
  /** Human-readable action verb, e.g. `'create_task'` or `'send_channel_message'`. */
  action: string;
  /**
   * Structured JSON payload describing the requested action. Persisted
   * verbatim into `Approval.payload`. Pass an empty object (`{}`) when
   * the action carries no parameters.
   */
  payload: Prisma.InputJsonValue;
}

/**
 * Create a new approval request and broadcast `approval:created`.
 *
 * Steps:
 *   1. Persist the {@link Approval} row with `status = 'PENDING'`,
 *      `workspaceId = resolveWorkspaceId()`, and the caller-supplied
 *      `aiUserId`, `action`, and `payload`.
 *   2. After the write commits, broadcast `approval:created` to the
 *      `workspace:{WORKSPACE_ID}` room. If the Socket.io server is not
 *      yet initialized, the broadcast is a no-op (the persistence is
 *      unaffected).
 *
 * Persistence failures rethrow the original Prisma error and the
 * realtime layer is **not** invoked, satisfying Requirements 8.6 / 10.4.
 *
 * Validates: Requirements 5.8, 6.1, 6.2, 8.6, 10.4.
 *
 * @param input - {@link CreateApprovalInput} describing the request.
 * @returns The persisted {@link Approval} record (with `status = 'PENDING'`).
 * @throws The original Prisma error when persistence fails. The realtime
 *   layer is not invoked in that case.
 *
 * @example
 * ```ts
 * const approval = await ApprovalService.create({
 *   aiUserId: aiAda.id,
 *   action: 'create_task',
 *   payload: { title: 'Draft RFC', assigneeId: humanUser.id },
 * });
 * // approval.status === 'PENDING'
 * ```
 */
export async function create(
  input: CreateApprovalInput,
): Promise<Approval> {
  const workspaceId = resolveWorkspaceId();

  const approval = await prisma.approval.create({
    data: {
      workspaceId,
      aiUserId: input.aiUserId,
      action: input.action,
      payload: input.payload,
      status: 'PENDING',
    },
  });

  // Persistence committed — safe to broadcast.
  broadcastApprovalCreated(approval);
  return approval;
}

/**
 * Transition a `PENDING` approval to `APPROVED` and wake up the
 * requesting AI colleague.
 *
 * Steps:
 *   1. Update the row: `status = 'APPROVED'`, `decidedById`, `decidedAt
 *      = now`. The returned record carries `aiUserId` so we can route
 *      the wakeup to the right cycle.
 *   2. After the write commits, emit `wakeup` on the {@link
 *      agenticEmitter} carrying `approval.aiUserId`. The Agentic Loop's
 *      `wakeup` listener invokes `runForAI(aiUserId)` immediately,
 *      bypassing the 30 s tick.
 *
 * Persistence failures rethrow the original Prisma error (e.g. row
 * missing) and **do not** emit on the emitter, so a failed transition
 * never spuriously resumes an AI cycle.
 *
 * Validates: Requirements 6.2, 6.3, 6.6.
 *
 * @param id - The internal cuid (`Approval.id`) of the approval to update.
 * @param decidedById - The human user (`User.id`) who approved the request.
 *   Stored on the row for audit purposes.
 * @returns The updated {@link Approval} record (with `status = 'APPROVED'`).
 * @throws The original Prisma error when persistence fails. The
 *   {@link agenticEmitter} is not invoked in that case.
 *
 * @example
 * ```ts
 * await ApprovalService.approve(approval.id, humanUser.id);
 * // → emits 'wakeup' on agenticEmitter with approval.aiUserId
 * ```
 */
export async function approve(
  id: string,
  decidedById: string,
): Promise<Approval> {
  const workspaceId = resolveWorkspaceId();
  const approval = await prisma.approval.update({
    // Scope by workspaceId so a signed-in user from a different
    // workspace cannot decide approvals they do not own. Prisma
    // raises P2025 when the WHERE returns 0 rows, which the route
    // layer maps to 404 — exactly the right user-visible response
    // for a cross-workspace probe (audit finding H4).
    where: { id, workspaceId, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      decidedById,
      decidedAt: new Date(),
    },
  });

  // Persistence committed — safe to wake up the Agentic Loop. Note that
  // we intentionally emit on `wakeup` (not `reject`) for APPROVED
  // transitions; design.md couples the two channels with opposite
  // semantics.
  agenticEmitter.emit('wakeup', approval.aiUserId);
  return approval;
}

/**
 * Transition a `PENDING` approval to `REJECTED` and signal the
 * requesting AI colleague to terminate its current decision cycle.
 *
 * Steps:
 *   1. Update the row: `status = 'REJECTED'`, `decidedById`, `decidedAt
 *      = now`.
 *   2. After the write commits, emit `reject` on the
 *      {@link agenticEmitter} carrying `approval.aiUserId`. The AI
 *      Runtime listens on this channel to abort the in-flight cycle
 *      with `finishReason = 'rejected'`. **No `wakeup` is emitted**:
 *      rejection terminates the current cycle but does not start a new
 *      one (Requirements 6.4).
 *
 * Persistence failures rethrow the original Prisma error and **do not**
 * emit on the emitter, so a failed transition never spuriously cancels
 * an AI cycle.
 *
 * Validates: Requirements 6.2, 6.4.
 *
 * @param id - The internal cuid (`Approval.id`) of the approval to update.
 * @param decidedById - The human user (`User.id`) who rejected the request.
 *   Stored on the row for audit purposes.
 * @returns The updated {@link Approval} record (with `status = 'REJECTED'`).
 * @throws The original Prisma error when persistence fails. The
 *   {@link agenticEmitter} is not invoked in that case.
 *
 * @example
 * ```ts
 * await ApprovalService.reject(approval.id, humanUser.id);
 * // → emits 'reject' on agenticEmitter; does NOT emit 'wakeup'
 * ```
 */
export async function reject(
  id: string,
  decidedById: string,
): Promise<Approval> {
  const workspaceId = resolveWorkspaceId();
  const approval = await prisma.approval.update({
    // Same workspace scoping as `approve` — keeps cross-workspace
    // callers from cancelling other teams' approvals (audit H4).
    where: { id, workspaceId, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      decidedById,
      decidedAt: new Date(),
    },
  });

  // Persistence committed — signal cancellation on the dedicated
  // `reject` channel. Crucially we DO NOT emit `wakeup`; rejection
  // terminates the current cycle, it does not start a new one.
  agenticEmitter.emit('reject', approval.aiUserId);
  return approval;
}

/**
 * Return every still-pending approval associated with the given AI
 * colleague. Used by the Agentic Loop as the gating predicate before
 * starting a new cycle: a non-empty result means the AI is blocked and
 * the loop should skip its turn (Requirements 6.5).
 *
 * The query is unordered because callers only inspect the list's
 * length, not its contents; switching to an ordered query in the future
 * would not change the gating semantics.
 *
 * Validates: Requirements 6.5, 7.2.
 *
 * @param aiUserId - The AI colleague (`User.id`) to query.
 * @returns Pending approvals for `aiUserId`. Empty array when none
 *   exist (i.e. the AI is unblocked).
 *
 * @example
 * ```ts
 * const pending = await ApprovalService.listPendingForAI(aiAda.id);
 * if (pending.length > 0) return; // skip this tick
 * ```
 */
export async function listPendingForAI(
  aiUserId: string,
): Promise<Approval[]> {
  return prisma.approval.findMany({
    where: { aiUserId, status: 'PENDING' },
  });
}

/**
 * Pure predicate: return `true` iff the given approval has been
 * outstanding for more than 24 hours measured from `now`.
 *
 * The check is strict (`>`), so an approval whose age is exactly
 * `STALE_THRESHOLD_MS` is **not** considered stale yet — only ages
 * strictly greater than the threshold flip the result to `true`. This
 * matches Requirement 6.7 ("24 小时后仍未被处理 ... 视为陈旧"). The
 * approval row is not mutated by this query; status is preserved as-is
 * and any UI surfacing happens at the caller (Requirements 6.7).
 *
 * Validates: Requirements 6.7.
 *
 * @param approval - The approval whose age is being checked. Only the
 *   `createdAt` field is consulted.
 * @param now - Reference timestamp; defaults to `new Date()`. Accepting
 *   an explicit `now` keeps this helper deterministic for tests.
 * @returns `true` iff `now - approval.createdAt > 24h`.
 *
 * @example
 * ```ts
 * if (ApprovalService.isStale(approval)) {
 *   // surface a stale badge in the UI; status remains PENDING
 * }
 * ```
 */
export function isStale(
  approval: Pick<Approval, 'createdAt'>,
  now: Date = new Date(),
): boolean {
  return now.getTime() - approval.createdAt.getTime() > STALE_THRESHOLD_MS;
}

/**
 * Aggregated namespace export so callers can use either named imports
 * or the `ApprovalService.method(...)` style favored across the spec.
 */
export const ApprovalService = {
  create,
  approve,
  reject,
  listPendingForAI,
  isStale,
} as const;
