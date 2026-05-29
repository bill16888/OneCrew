import '../../setup';

/**
 * @file Tests for the dashboard summary aggregation (Phase 1 Req 13).
 *
 * Prisma is mocked so the test pins the aggregation CONTRACT — panel
 * shape, AI thinking-state join, pending-approval projection, and the
 * merged/sorted recent-activity timeline — without a real database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  thinking: [] as string[],
  counts: { messagesTotal: 0, messagesFromAI: 0, tasksCompleted: 0, approvalsDecided: 0 },
  aiUsers: [] as Array<{ id: string; name: string; aiStatus: string | null }>,
  pending: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  tasks: [] as Array<Record<string, unknown>>,
  approvals: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/realtime/thinking', () => ({
  getThinkingSnapshot: () => hoisted.thinking,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    message: {
      count: vi.fn(async (args: { where: { user?: { isAI: boolean } } }) =>
        args.where.user?.isAI ? hoisted.counts.messagesFromAI : hoisted.counts.messagesTotal,
      ),
      findMany: vi.fn(async () => hoisted.messages),
    },
    task: {
      count: vi.fn(async () => hoisted.counts.tasksCompleted),
      findMany: vi.fn(async () => hoisted.tasks),
    },
    approval: {
      count: vi.fn(async () => hoisted.counts.approvalsDecided),
      findMany: vi.fn(async (args: { where: { status?: string } }) =>
        args.where.status === 'PENDING' ? hoisted.pending : hoisted.approvals,
      ),
    },
    user: {
      findMany: vi.fn(async () => hoisted.aiUsers),
    },
  },
}));

import { getDashboardSummary } from '@/lib/services/dashboard.service';

beforeEach(() => {
  hoisted.thinking = [];
  hoisted.counts = {
    messagesTotal: 12,
    messagesFromAI: 5,
    tasksCompleted: 3,
    approvalsDecided: 2,
  };
  hoisted.aiUsers = [
    { id: 'ai_1', name: 'Architect', aiStatus: 'active' },
    { id: 'ai_2', name: 'Coordinator', aiStatus: 'inactive' },
  ];
  hoisted.pending = [
    {
      id: 'appr_1',
      aiUserId: 'ai_1',
      action: 'deploy',
      status: 'PENDING',
      createdAt: new Date('2026-05-29T10:00:00Z'),
      aiUser: { name: 'Architect' },
    },
  ];
  hoisted.messages = [
    {
      id: 'msg_1',
      content: 'hello world',
      createdAt: new Date('2026-05-29T12:00:00Z'),
      user: { name: 'Mia', isAI: false },
      channel: { name: 'general' },
    },
  ];
  hoisted.tasks = [
    {
      id: 'task_1',
      taskId: 'PROJ-1',
      title: 'Wire dashboard',
      status: 'Done',
      updatedAt: new Date('2026-05-29T13:00:00Z'),
    },
  ];
  hoisted.approvals = [
    {
      id: 'appr_1',
      aiUserId: 'ai_1',
      action: 'deploy',
      status: 'PENDING',
      createdAt: new Date('2026-05-29T10:00:00Z'),
      aiUser: { name: 'Architect' },
    },
  ];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getDashboardSummary', () => {
  it('projects the pulse counts (human vs AI split)', async () => {
    const summary = await getDashboardSummary();
    expect(summary.pulse).toEqual({
      messagesTotal: 12,
      messagesFromAI: 5,
      tasksCompleted: 3,
      approvalsDecided: 2,
    });
  });

  it('marks AIs present in the thinking snapshot as isThinking', async () => {
    hoisted.thinking = ['ai_1'];
    const summary = await getDashboardSummary();
    const architect = summary.ai.find((a) => a.id === 'ai_1');
    const coordinator = summary.ai.find((a) => a.id === 'ai_2');
    expect(architect?.isThinking).toBe(true);
    expect(coordinator?.isThinking).toBe(false);
    expect(coordinator?.aiStatus).toBe('inactive');
  });

  it('projects pending approvals with the AI name resolved', async () => {
    const summary = await getDashboardSummary();
    expect(summary.pendingApprovals).toHaveLength(1);
    expect(summary.pendingApprovals[0]).toMatchObject({
      id: 'appr_1',
      aiName: 'Architect',
      action: 'deploy',
    });
  });

  it('merges activity sources and sorts by timestamp descending', async () => {
    const summary = await getDashboardSummary();
    // task @13:00 > message @12:00 > approval @10:00
    expect(summary.recentActivity.map((a) => a.kind)).toEqual([
      'task',
      'message',
      'approval',
    ]);
    // timestamps strictly non-increasing
    const times = summary.recentActivity.map((a) => a.at);
    const sorted = [...times].sort((x, y) => (x < y ? 1 : -1));
    expect(times).toEqual(sorted);
  });

  it('flags AI-authored messages in the timeline', async () => {
    hoisted.messages = [
      {
        id: 'msg_ai',
        content: 'daily report',
        createdAt: new Date('2026-05-29T14:00:00Z'),
        user: { name: 'Architect', isAI: true },
        channel: { name: 'general' },
      },
    ];
    const summary = await getDashboardSummary();
    const msg = summary.recentActivity.find((a) => a.kind === 'message');
    expect(msg?.fromAI).toBe(true);
  });
});
