import '../../setup';

/**
 * @file Property tests for `TaskService.updateStatus` value-domain
 * enforcement and `TaskService.create` monotonic ID generation.
 *
 * Property 8 (状态更新值域): for any string `s`, updateStatus
 * succeeds iff `s ∈ {Backlog, InProgress, InReview, Done}`; otherwise
 * it rejects with a `ValidationError` and the underlying row is left
 * untouched.
 *
 * Property 6 partial (Task ID 单调递增且唯一): inside a single
 * sequence of `TaskService.create` calls, the parsed integers from
 * `taskId` strings are strictly increasing.
 *
 * Validates: Requirements 3.2, 3.4, 5.6 (P2 tasks 7.5, 7.7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

const hoisted = vi.hoisted(() => {
  const counter = { value: 0 };
  return {
    counter,
    txWorkspaceUpdate: vi.fn(async () => {
      counter.value += 1;
      return { taskCounter: counter.value };
    }),
    txTaskCreate: vi.fn(
      async ({
        data,
      }: {
        data: { taskId: string; status: string; isAITask: boolean };
      }) => ({
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
      }),
    ),
    taskUpdateMock: vi.fn(
      async ({ data }: { data: { status: string } }) => ({
        id: 'internal_x',
        taskId: 'PROJ-1',
        title: 'mocked',
        description: null,
        status: data.status,
        isAITask: false,
        creatorId: 'creator_x',
        assigneeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ),
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        workspace: { update: hoisted.txWorkspaceUpdate },
        user: {
          findUniqueOrThrow: vi.fn(async () => ({
            id: 'creator_x',
            isAI: false,
          })),
          findUnique: vi.fn(async () => null),
        },
        task: { create: hoisted.txTaskCreate },
      }),
    task: {
      // Audit H4 scopes updateStatus by workspaceId via a separate
      // findFirst; return a synthetic row so the subsequent update
      // call inside the same code path proceeds.
      findFirst: vi.fn(async (args: { where: { taskId: string } }) => ({
        id: `internal_${args.where.taskId}`,
      })),
      update: hoisted.taskUpdateMock,
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({ getIO: () => null }));

import {
  TaskService,
  TASK_STATUSES,
  ValidationError,
} from '@/lib/services/task.service';

beforeEach(() => {
  hoisted.counter.value = 0;
  hoisted.taskUpdateMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 8: 状态更新值域', () => {
  it('accepts the four valid statuses', async () => {
    for (const status of TASK_STATUSES) {
      hoisted.taskUpdateMock.mockClear();
      const out = await TaskService.updateStatus('PROJ-1', status);
      expect(out.status).toBe(status);
      expect(hoisted.taskUpdateMock).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects any string outside the four allowed values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((s) => !(TASK_STATUSES as readonly string[]).includes(s)),
        async (bad) => {
          hoisted.taskUpdateMock.mockClear();
          await expect(
            TaskService.updateStatus('PROJ-1', bad),
          ).rejects.toBeInstanceOf(ValidationError);
          // The DB row was NOT touched.
          expect(hoisted.taskUpdateMock).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('Feature: ai-native-team-workspace, Property 6 partial: Task ID 单调递增', () => {
  it('a sequence of creates yields strictly increasing PROJ-{N}', async () => {
    hoisted.counter.value = 0;
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = await TaskService.create({
        title: `t${i}`,
        creatorId: 'creator_x',
      });
      ids.push(t.taskId);
    }
    const numbers = ids.map((id) => {
      const match = /^PROJ-(\d+)$/.exec(id);
      expect(match).not.toBeNull();
      return Number((match as RegExpExecArray)[1]);
    });
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
