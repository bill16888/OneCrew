import '../../setup';

/**
 * @file Tests for the teammate task summary (direction D, Req 20).
 *
 * Covers TaskService.resolveTeammate (workspace-scoped AI lookup by id
 * or name) and TaskService.summarizeForAI (counts by status + last-24h
 * titles). Prisma is mocked so the contract is pinned without a
 * database; these are pure reads with no broadcasts or wakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;

const hoisted = vi.hoisted(() => ({
  userById: null as { id: string; name: string } | null,
  userByName: null as { id: string; name: string } | null,
  lastUserWhere: null as Record<string, unknown> | null,
  lastTaskWhere: null as Record<string, unknown> | null,
  tasks: [] as Array<{
    taskId: string;
    title: string;
    status: string;
    updatedAt: Date;
  }>,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        hoisted.lastUserWhere = args.where;
        // resolveTeammate queries by `id` first, then by `name`.
        if ('id' in args.where) return hoisted.userById;
        if ('name' in args.where) return hoisted.userByName;
        return null;
      }),
    },
    task: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        hoisted.lastTaskWhere = args.where;
        return hoisted.tasks;
      }),
    },
  },
}));

import { TaskService } from '@/lib/services/task.service';

beforeEach(() => {
  hoisted.userById = null;
  hoisted.userByName = null;
  hoisted.lastUserWhere = null;
  hoisted.lastTaskWhere = null;
  hoisted.tasks = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TaskService.resolveTeammate (Req 20.2)', () => {
  it('resolves by aiUserId (id lookup, AI + workspace scoped)', async () => {
    hoisted.userById = { id: 'ai_ada', name: 'Ada' };
    const target = await TaskService.resolveTeammate({ aiUserId: 'ai_ada' });
    expect(target).toEqual({ id: 'ai_ada', name: 'Ada' });
    expect(hoisted.lastUserWhere).toMatchObject({ id: 'ai_ada', isAI: true });
    expect(hoisted.lastUserWhere?.workspaceId).toBeDefined();
  });

  it('resolves by aiName with case-insensitive matching', async () => {
    hoisted.userByName = { id: 'ai_hopper', name: 'Hopper' };
    const target = await TaskService.resolveTeammate({ aiName: 'hopper' });
    expect(target).toEqual({ id: 'ai_hopper', name: 'Hopper' });
    // The name lookup must be case-insensitive so "hopper" matches "Hopper".
    expect(hoisted.lastUserWhere?.name).toEqual({
      equals: 'hopper',
      mode: 'insensitive',
    });
    expect(hoisted.lastUserWhere).toMatchObject({ isAI: true });
  });

  it('prefers id over name when both are provided and the id matches', async () => {
    hoisted.userById = { id: 'ai_ada', name: 'Ada' };
    hoisted.userByName = { id: 'ai_hopper', name: 'Hopper' };
    const target = await TaskService.resolveTeammate({
      aiUserId: 'ai_ada',
      aiName: 'Hopper',
    });
    expect(target).toEqual({ id: 'ai_ada', name: 'Ada' });
    // The id lookup short-circuits, so the last where seen is the id one.
    expect(hoisted.lastUserWhere).toMatchObject({ id: 'ai_ada' });
  });

  it('falls back to name when the id does not resolve', async () => {
    hoisted.userById = null;
    hoisted.userByName = { id: 'ai_hopper', name: 'Hopper' };
    const target = await TaskService.resolveTeammate({
      aiUserId: 'missing',
      aiName: 'Hopper',
    });
    expect(target).toEqual({ id: 'ai_hopper', name: 'Hopper' });
  });

  it('returns null when neither id nor name resolves to an AI', async () => {
    hoisted.userById = null;
    hoisted.userByName = null;
    const target = await TaskService.resolveTeammate({ aiName: 'Nobody' });
    expect(target).toBeNull();
  });
});

describe('TaskService.summarizeForAI (Req 20.3)', () => {
  it('counts tasks by status across the four columns', async () => {
    const now = Date.now();
    hoisted.tasks = [
      { taskId: 'PROJ-1', title: 'a', status: 'Backlog', updatedAt: new Date(now) },
      { taskId: 'PROJ-2', title: 'b', status: 'InProgress', updatedAt: new Date(now) },
      { taskId: 'PROJ-3', title: 'c', status: 'InProgress', updatedAt: new Date(now) },
      { taskId: 'PROJ-4', title: 'd', status: 'Done', updatedAt: new Date(now) },
    ];
    const summary = await TaskService.summarizeForAI('ai_ada');
    expect(summary.total).toBe(4);
    expect(summary.counts).toEqual({
      Backlog: 1,
      InProgress: 2,
      InReview: 0,
      Done: 1,
    });
  });

  it('scopes the read to the AI as creator OR assignee, workspace-scoped', async () => {
    await TaskService.summarizeForAI('ai_ada');
    expect(hoisted.lastTaskWhere?.workspaceId).toBeDefined();
    expect(hoisted.lastTaskWhere?.OR).toEqual([
      { creatorId: 'ai_ada' },
      { assigneeId: 'ai_ada' },
    ]);
  });

  it('returns only tasks updated within the last 24h in recentlyUpdated', async () => {
    const now = Date.now();
    hoisted.tasks = [
      { taskId: 'PROJ-1', title: 'fresh', status: 'Done', updatedAt: new Date(now - 1000) },
      { taskId: 'PROJ-2', title: 'stale', status: 'Done', updatedAt: new Date(now - 2 * DAY_MS) },
    ];
    const summary = await TaskService.summarizeForAI('ai_ada');
    // counts include ALL tasks, recentlyUpdated only the fresh one.
    expect(summary.total).toBe(2);
    expect(summary.counts.Done).toBe(2);
    expect(summary.recentlyUpdated).toEqual([
      { taskId: 'PROJ-1', title: 'fresh', status: 'Done' },
    ]);
  });

  it('caps recentlyUpdated at 20 entries', async () => {
    const now = Date.now();
    hoisted.tasks = Array.from({ length: 25 }, (_, i) => ({
      taskId: `PROJ-${i + 1}`,
      title: `t${i + 1}`,
      status: 'InProgress',
      updatedAt: new Date(now - 1000),
    }));
    const summary = await TaskService.summarizeForAI('ai_ada');
    expect(summary.total).toBe(25);
    expect(summary.recentlyUpdated).toHaveLength(20);
  });

  it('returns zeroed counts and empty recents for an AI with no tasks', async () => {
    hoisted.tasks = [];
    const summary = await TaskService.summarizeForAI('ai_idle');
    expect(summary.total).toBe(0);
    expect(summary.counts).toEqual({
      Backlog: 0,
      InProgress: 0,
      InReview: 0,
      Done: 0,
    });
    expect(summary.recentlyUpdated).toEqual([]);
  });
});
