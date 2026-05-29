/**
 * @file Server-side notification emitter (Phase 1 Req 18).
 *
 * A thin helper that broadcasts `notification:new` to the workspace
 * room. Service layers call the typed convenience functions below after
 * a successful commit (approvals, task→Done) or when the AI budget
 * breaker trips. The client (`NotificationProvider`) turns these into
 * desktop + in-app notifications, with throttling / dedup handled
 * client-side (Req 18.3 / 18.4).
 *
 * Emitting is best-effort and no-ops when the Socket.io server is not
 * yet wired (tests, pre-`server.ts`): notifications are a UI nicety, so
 * a missing IO must never break the underlying write.
 *
 * Validates: Phase 1 Req 18.2.
 */

import { EVENTS, type NotificationNewPayload } from '@/lib/realtime/events';
import { getIO } from '@/lib/realtime/io';
import { resolveWorkspaceId } from '@/lib/workspace';

/**
 * Broadcast a `notification:new` event to the active workspace room.
 * No-ops when the IO server is not initialised.
 */
export function emitNotification(
  payload: Omit<NotificationNewPayload, 'createdAt'>,
): void {
  const io = getIO();
  if (!io) return;
  const room = `workspace:${resolveWorkspaceId()}`;
  io.to(room).emit(EVENTS.NotificationNew, {
    ...payload,
    createdAt: new Date().toISOString(),
  });
}

/** A new approval is awaiting the operator's decision. */
export function notifyApprovalPending(action: string, aiName: string): void {
  emitNotification({
    category: 'approval',
    title: '待审批',
    body: `${aiName} 请求执行：${action}`,
    href: '/dashboard',
  });
}

/** A task the operator created moved to Done. */
export function notifyTaskDone(taskId: string, title: string): void {
  emitNotification({
    category: 'task_done',
    title: '任务完成',
    body: `${taskId} ${title} 已完成`,
    href: '/board',
  });
}

/** The daily AI budget breaker tripped. */
export function notifyBudgetExceeded(): void {
  emitNotification({
    category: 'budget',
    title: 'AI 预算已用尽',
    body: '今日 AI 预算已达上限，将于明日 UTC 0 点恢复。',
    href: '/dashboard',
  });
}
