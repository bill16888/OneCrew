import '../../setup';

/**
 * @file Tests for AI task hand-off service methods (direction D,
 * Req 21): TaskService.assign and TaskService.resolveHandoffTarget.
 *
 * Prisma is mocked so the contract is pinned without a database. assign
 * is a workspace-scoped write; resolveHandoffTarget is two reads
 * (teammate resolution + channel-sharing existence check).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  taskUpdate: vi.fn(),
  userFindFirst: vi.fn(),
  channelMemberFindFirst: vi.fn(),
  lastChannelMemberWhere: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    task: { findFirst: hoisted.taskFindFirst, update: hoisted.taskUpdate },
    user: { findFirst: hoisted.userFindFirst },
    channelMember: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        hoisted.lastChannelMemberWhere = args.where;
        return hoisted.channelMemberFindFirst(args);
      }),
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({ getIO: () => null }));

import { TaskService, ValidationError } from '@/lib/services/task.service';

beforeEach(() => {
  hoisted.taskFindFirst.mockReset();
  hoisted.taskUpdate.mockReset();
  hoisted.userFindFirst.mockReset();
  hoisted.channelMemberFindFirst.mockReset();
  hoisted.lastChannelMemberWhere = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TaskService.assign (Req 21.2)', () => {
  it('updates assigneeId and marks the task as an AI task', async () => {
    hoisted.taskFindFirst.mockResolvedValue({ id: 'tk_1' });
    hoisted.taskUpdate.mockResolvedValue({
      id: 'tk_1',
      taskId: 'PROJ-1',
      title: 't',
      description: null,
      status: 'Backlog',
      isAITask: true,
      creatorId: 'u_human',
      assigneeId: 'ai_hopper',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const task = await TaskService.assign('PROJ-1', 'ai_hopper');
    expect(task.assigneeId).toBe('ai_hopper');
    expect(task.isAITask).toBe(true);

    // Located by human-readable taskId, workspace-scoped.
    expect(hoisted.taskFindFirst.mock.calls[0][0].where).toMatchObject({
      taskId: 'PROJ-1',
    });
    expect(hoisted.taskUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'tk_1' },
      data: { assigneeId: 'ai_hopper', isAITask: true },
    });
  });

  it('throws ValidationError when the task is not in the workspace', async () => {
    hoisted.taskFindFirst.mockResolvedValue(null);
    await expect(TaskService.assign('PROJ-404', 'ai_hopper')).rejects.toThrow(
      ValidationError,
    );
    expect(hoisted.taskUpdate).not.toHaveBeenCalled();
  });
});

describe('TaskService.resolveHandoffTarget (Req 21.4)', () => {
  it('returns not_found when no matching AI exists', async () => {
    hoisted.userFindFirst.mockResolvedValue(null);
    const result = await TaskService.resolveHandoffTarget({
      callerId: 'ai_caller',
      assigneeName: 'Ghost',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(hoisted.channelMemberFindFirst).not.toHaveBeenCalled();
  });

  it('returns not_shared_channel when the AI shares no channel with the caller', async () => {
    hoisted.userFindFirst.mockResolvedValue({ id: 'ai_hopper', name: 'Hopper' });
    hoisted.channelMemberFindFirst.mockResolvedValue(null);
    const result = await TaskService.resolveHandoffTarget({
      callerId: 'ai_caller',
      assigneeId: 'ai_hopper',
    });
    expect(result).toEqual({ ok: false, reason: 'not_shared_channel' });
    // The sharing check is anchored on the target, gated by the caller's membership.
    expect(hoisted.lastChannelMemberWhere).toMatchObject({
      userId: 'ai_hopper',
      channel: { members: { some: { userId: 'ai_caller' } } },
    });
  });

  it('returns ok with the resolved id and name when a shared channel exists', async () => {
    hoisted.userFindFirst.mockResolvedValue({ id: 'ai_hopper', name: 'Hopper' });
    hoisted.channelMemberFindFirst.mockResolvedValue({ channelId: 'chan_eng' });
    const result = await TaskService.resolveHandoffTarget({
      callerId: 'ai_caller',
      assigneeName: 'hopper',
    });
    expect(result).toEqual({ ok: true, id: 'ai_hopper', name: 'Hopper' });
  });
});
