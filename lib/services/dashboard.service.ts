/**
 * @file Dashboard summary aggregation (Phase 1 Req 13).
 *
 * Produces the single payload that backs the operator dashboard's four
 * panels (today's pulse, AI status, pending approvals, recent
 * activity). Both the server-rendered dashboard page and the
 * `/api/dashboard/summary` endpoint call {@link getDashboardSummary} so
 * the first paint and the client-side refresh share one source of
 * truth.
 *
 * Performance (Req 13.5 / the < 2s P99 budget): all reads fire in a
 * single `Promise.all` so the request is bounded by the slowest query
 * rather than their sum. The thinking snapshot is read from memory
 * (`lib/realtime/thinking.ts`), not the DB.
 *
 * Validates: Phase 1 Req 13.2, 13.5.
 */

import prisma from '@/lib/prisma';
import { getThinkingSnapshot } from '@/lib/realtime/thinking';
import { resolveWorkspaceId } from '@/lib/workspace';

const PULSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_ACTIVITY_LIMIT = 20;

/** Counts of activity in the last 24h, split human vs AI where relevant. */
export interface DashboardPulse {
  readonly messagesTotal: number;
  readonly messagesFromAI: number;
  readonly tasksCompleted: number;
  readonly approvalsDecided: number;
}

/** One AI colleague's status card data. */
export interface DashboardAIStatus {
  readonly id: string;
  readonly name: string;
  readonly aiStatus: string;
  readonly isThinking: boolean;
}

/** A pending approval awaiting the operator's decision. */
export interface DashboardPendingApproval {
  readonly id: string;
  readonly aiUserId: string;
  readonly aiName: string;
  readonly action: string;
  readonly createdAt: string;
}

/** A single entry in the recent-activity timeline. */
export interface DashboardActivityItem {
  readonly kind: 'message' | 'task' | 'approval';
  readonly id: string;
  readonly at: string;
  readonly summary: string;
  /** Present for messages flagged as authored by an AI. */
  readonly fromAI?: boolean;
}

/** The consolidated dashboard payload. */
export interface DashboardSummary {
  readonly pulse: DashboardPulse;
  readonly ai: DashboardAIStatus[];
  readonly pendingApprovals: DashboardPendingApproval[];
  readonly recentActivity: DashboardActivityItem[];
}

/**
 * Build the dashboard summary for the active workspace.
 *
 * @param now Reference timestamp; defaults to `new Date()`. Accepting
 *   it explicitly keeps the 24h-window queries deterministic in tests.
 */
export async function getDashboardSummary(
  now: Date = new Date(),
): Promise<DashboardSummary> {
  const workspaceId = resolveWorkspaceId();
  const windowStart = new Date(now.getTime() - PULSE_WINDOW_MS);

  const [
    messagesTotal,
    messagesFromAI,
    tasksCompleted,
    approvalsDecided,
    aiUsers,
    pendingRows,
    recentMessages,
    recentTasks,
    recentApprovals,
  ] = await Promise.all([
    // Pulse counts (last 24h).
    prisma.message.count({
      where: { channel: { workspaceId }, createdAt: { gte: windowStart } },
    }),
    prisma.message.count({
      where: {
        channel: { workspaceId },
        createdAt: { gte: windowStart },
        user: { isAI: true },
      },
    }),
    prisma.task.count({
      where: { workspaceId, status: 'Done', updatedAt: { gte: windowStart } },
    }),
    prisma.approval.count({
      where: {
        workspaceId,
        status: { in: ['APPROVED', 'REJECTED'] },
        decidedAt: { gte: windowStart },
      },
    }),
    // AI status cards.
    prisma.user.findMany({
      where: { workspaceId, isAI: true },
      select: { id: true, name: true, aiStatus: true },
      orderBy: [{ aiStatus: 'asc' }, { name: 'asc' }],
    }),
    // Pending approvals (oldest first — Req 13.2).
    prisma.approval.findMany({
      where: { workspaceId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { aiUser: { select: { name: true } } },
    }),
    // Recent activity sources.
    prisma.message.findMany({
      where: { channel: { workspaceId } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_ACTIVITY_LIMIT,
      include: {
        user: { select: { name: true, isAI: true } },
        channel: { select: { name: true } },
      },
    }),
    prisma.task.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: RECENT_ACTIVITY_LIMIT,
    }),
    prisma.approval.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_ACTIVITY_LIMIT,
      include: { aiUser: { select: { name: true } } },
    }),
  ]);

  const thinking = new Set(getThinkingSnapshot());

  const ai: DashboardAIStatus[] = aiUsers.map((u) => ({
    id: u.id,
    name: u.name,
    aiStatus: u.aiStatus ?? 'active',
    isThinking: thinking.has(u.id),
  }));

  const pendingApprovals: DashboardPendingApproval[] = pendingRows.map((a) => ({
    id: a.id,
    aiUserId: a.aiUserId,
    aiName: a.aiUser?.name ?? a.aiUserId,
    action: a.action,
    createdAt: a.createdAt.toISOString(),
  }));

  // Merge the three activity sources, sort by timestamp desc, cap.
  const activity: DashboardActivityItem[] = [
    ...recentMessages.map((m): DashboardActivityItem => ({
      kind: 'message',
      id: m.id,
      at: m.createdAt.toISOString(),
      fromAI: m.user.isAI,
      summary: `${m.user.name} 在 #${m.channel.name}: ${truncate(m.content, 80)}`,
    })),
    ...recentTasks.map((t): DashboardActivityItem => ({
      kind: 'task',
      id: t.id,
      at: t.updatedAt.toISOString(),
      summary: `${t.taskId} ${t.title} → ${t.status}`,
    })),
    ...recentApprovals.map((a): DashboardActivityItem => ({
      kind: 'approval',
      id: a.id,
      at: a.createdAt.toISOString(),
      summary: `${a.aiUser?.name ?? a.aiUserId} 请求审批: ${a.action} (${a.status})`,
    })),
  ]
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
    .slice(0, RECENT_ACTIVITY_LIMIT);

  return {
    pulse: {
      messagesTotal,
      messagesFromAI,
      tasksCompleted,
      approvalsDecided,
    },
    ai,
    pendingApprovals,
    recentActivity: activity,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export const DashboardService = {
  getDashboardSummary,
} as const;
