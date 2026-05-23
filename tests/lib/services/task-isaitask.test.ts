import '../../setup';

/**
 * @file Property test for `TaskService.create` `isAITask` derivation
 * and surrounding broadcast / default-status invariants.
 *
 * Properties covered:
 *   - Property 10 (isAITask 派生): isAITask = creator.isAI ||
 *     (assignee?.isAI ?? false).
 *   - Property 7 (新任务默认 Backlog).
 *   - Property 9 partial (创建广播一致性): exactly one `task:updated`
 *     event per successful create.
 *
 * Validates: Requirements 3.3, 3.5, 3.6, 5.5 (P2 tasks 7.6, 7.8, 7.9).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

interface UserRow {
  id: string;
  isAI: boolean;
}
interface CapturedEmit {
  room: string;
  event: string;
}
interface LastTaskRef {
  value: { isAITask: boolean; status: string } | null;
}

const hoisted = vi.hoisted(() => {
  const users = new Map<string, UserRow>();
  const counter = { value: 0 };
  const lastTask: LastTaskRef = { value: null };
  const emitted: CapturedEmit[] = [];
  const lastRoom = { value: '' };

  return {
    users,
    counter,
    lastTask,
    emitted,
    lastRoom,
    txWorkspaceUpdate: vi.fn(async () => {
      counter.value += 1;
      return { taskCounter: counter.value };
    }),
    txUserFindUniqueOrThrow: vi.fn(
      async ({ where }: { where: { id: string } }) => {
        const row = users.get(where.id);
        if (!row) throw new Error(`user not found: ${where.id}`);
        return row;
      },
    ),
    txUserFindUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        users.get(where.id) ?? null,
    ),
    txTaskCreate: vi.fn(
      async ({
        data,
      }: {
        data: { taskId: string; status: string; isAITask: boolean };
      }) => {
        lastTask.value = { isAITask: data.isAITask, status: data.status };
        return {
          id: `internal_${data.taskId}`,
          taskId: data.taskId,
          title: 'mocked',
          description: null,
          status: data.status,
          isAITask: data.isAITask,
          creatorId: 'creator_x',
          assigneeId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    ),
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        workspace: { update: hoisted.txWorkspaceUpdate },
        user: {
          findUniqueOrThrow: hoisted.txUserFindUniqueOrThrow,
          findUnique: hoisted.txUserFindUnique,
        },
        task: { create: hoisted.txTaskCreate },
      }),
    task: { update: vi.fn(), findMany: vi.fn(async () => []) },
  },
}));

vi.mock('@/lib/realtime/io', () => ({
  getIO: () => ({
    to: (room: string) => {
      hoisted.lastRoom.value = room;
      return {
        emit: (event: string) => {
          hoisted.emitted.push({ room: hoisted.lastRoom.value, event });
        },
      };
    },
  }),
}));

import { TaskService } from '@/lib/services/task.service';

beforeEach(() => {
  hoisted.users.clear();
  hoisted.counter.value = 0;
  hoisted.lastTask.value = null;
  hoisted.emitted.splice(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 10: isAITask 派生自参与者', () => {
  it('isAITask = creator.isAI || (assignee?.isAI ?? false)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.option(fc.boolean(), { nil: undefined }),
        async (creatorIsAI, assigneeIsAI) => {
          hoisted.users.clear();
          hoisted.users.set('creator_x', { id: 'creator_x', isAI: creatorIsAI });
          if (assigneeIsAI !== undefined) {
            hoisted.users.set('assignee_x', {
              id: 'assignee_x',
              isAI: assigneeIsAI,
            });
          }
          hoisted.lastTask.value = null;
          await TaskService.create({
            title: 'hello',
            creatorId: 'creator_x',
            assigneeId:
              assigneeIsAI === undefined ? undefined : 'assignee_x',
          });
          const expected = creatorIsAI || (assigneeIsAI ?? false);
          const captured = hoisted.lastTask.value as
            | { isAITask: boolean; status: string }
            | null;
          expect(captured).not.toBeNull();
          expect(captured?.isAITask).toBe(expected);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('Feature: ai-native-team-workspace, Property 7: 新任务默认 Backlog', () => {
  it('every created task starts with status === Backlog', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 80 }),
        async (title) => {
          hoisted.users.clear();
          hoisted.users.set('creator_x', { id: 'creator_x', isAI: false });
          hoisted.lastTask.value = null;
          await TaskService.create({ title, creatorId: 'creator_x' });
          const captured = hoisted.lastTask.value as
            | { isAITask: boolean; status: string }
            | null;
          expect(captured).not.toBeNull();
          expect(captured?.status).toBe('Backlog');
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('Feature: ai-native-team-workspace, Property 9 partial: 创建广播一致性', () => {
  it('emits exactly one task:updated per create', async () => {
    hoisted.users.set('creator_x', { id: 'creator_x', isAI: false });
    hoisted.emitted.splice(0);
    await TaskService.create({ title: 'a', creatorId: 'creator_x' });
    expect(hoisted.emitted).toHaveLength(1);
    expect(hoisted.emitted[0].event).toBe('task:updated');
    expect(hoisted.emitted[0].room).toMatch(/^workspace:/);
  });
});
