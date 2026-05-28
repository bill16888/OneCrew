import '../../setup';

/**
 * @file Property 26 — 实时延迟上限。
 *
 * design.md 把 "实时延迟" 形式化为：从 service 层 commit (DB write 完
 * 成) 到 io.emit 调用之间的耗时。MVP 单进程架构没有跨进程发布订阅，
 * service 在 commit 之后立即 (同一个 microtask) 调用 getIO().to().emit()，
 * 所以这个延迟必须严格小于 1 秒，且实际应在毫秒量级。
 *
 * 本测试用 fake mock 取代 prisma + getIO，通过测量 service 调用从
 * "DB resolve" 到 "io.emit 被触发" 的真实墙钟差，断言 < 50 ms (远低于
 * 1 秒上限，留出 CI 抖动空间)。
 *
 * 覆盖三条事件路径：
 *   - MessageService.create        → message:new
 *   - TaskService.create           → task:updated
 *   - ApprovalService.create       → approval:created
 *
 * Validates: Requirements 8.4, 8.5, 8.6 (P2 task 3.14).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  /** 时间戳: prisma 操作 resolve 的瞬间 */
  dbCommittedAt: { value: 0 },
  /** 时间戳: getIO().to().emit() 被调用的瞬间 */
  emittedAt: { value: 0 },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    channel: {
      // Audit H4 added a workspace boundary check before the message
      // insert. Mock as a near-zero-cost passthrough so the latency
      // measurement reflects the actual create→emit gap and not the
      // synthetic boundary lookup.
      findFirst: vi.fn(async (args: { where: { id: string } }) => ({
        id: args.where.id,
      })),
    },
    message: {
      create: vi.fn(async (args: { data: { channelId: string; content: string; userId: string } }) => {
        hoisted.dbCommittedAt.value = performance.now();
        return {
          id: 'msg_1',
          channelId: args.data.channelId,
          userId: args.data.userId,
          content: args.data.content,
          metadata: null,
          createdAt: new Date(),
          user: { isAI: false },
        };
      }),
      findMany: vi.fn(async () => []),
    },
    task: {
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async (args: { where: { taskId: string } }) => ({
        id: `internal_${args.where.taskId}`,
      })),
      findMany: vi.fn(async () => []),
    },
    approval: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        hoisted.dbCommittedAt.value = performance.now();
        return {
          id: 'app_1',
          workspaceId: 'ws_test',
          aiUserId: args.data.aiUserId as string,
          action: args.data.action as string,
          payload: args.data.payload,
          status: args.data.status as string,
          createdAt: new Date(),
          decidedById: null,
          decidedAt: null,
        };
      }),
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const result = await fn({
        workspace: {
          update: vi.fn(async () => ({ taskCounter: 1 })),
        },
        user: {
          findUniqueOrThrow: vi.fn(async () => ({ id: 'creator_x', isAI: false })),
          findUnique: vi.fn(async () => null),
        },
        task: {
          create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
            id: 'internal_1',
            taskId: 'PROJ-1',
            title: args.data.title,
            description: null,
            status: 'Backlog',
            isAITask: false,
            workspaceId: 'ws_test',
            creatorId: 'creator_x',
            assigneeId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        },
      });
      hoisted.dbCommittedAt.value = performance.now();
      return result;
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({
  getIO: () => ({
    to: () => ({
      emit: () => {
        hoisted.emittedAt.value = performance.now();
      },
    }),
  }),
}));

vi.mock('@/lib/loop/emitter', () => ({
  agenticEmitter: {
    emit: vi.fn(() => true),
  },
}));

import { MessageService } from '@/lib/services/message.service';
import { TaskService } from '@/lib/services/task.service';
import { ApprovalService } from '@/lib/services/approval.service';

const LATENCY_BUDGET_MS = 50; // 远小于 spec 的 1 s 上限

beforeEach(() => {
  hoisted.dbCommittedAt.value = 0;
  hoisted.emittedAt.value = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 26: 实时延迟上限 (commit→emit < 1s)', () => {
  it('MessageService.create: commit→emit 延迟严格小于 50 ms', async () => {
    await MessageService.create({
      channelId: 'chan_general',
      userId: 'u_test',
      content: 'hi',
    });
    const latency = hoisted.emittedAt.value - hoisted.dbCommittedAt.value;
    expect(hoisted.emittedAt.value).toBeGreaterThan(0);
    expect(hoisted.dbCommittedAt.value).toBeGreaterThan(0);
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
  });

  it('TaskService.create: commit→emit 延迟严格小于 50 ms', async () => {
    await TaskService.create({
      title: 'hello',
      creatorId: 'creator_x',
    });
    const latency = hoisted.emittedAt.value - hoisted.dbCommittedAt.value;
    expect(hoisted.emittedAt.value).toBeGreaterThan(0);
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
  });

  it('ApprovalService.create: commit→emit 延迟严格小于 50 ms', async () => {
    await ApprovalService.create({
      aiUserId: 'user_ai_ada',
      action: 'send_channel_message',
      payload: { reason: 'r' },
    });
    const latency = hoisted.emittedAt.value - hoisted.dbCommittedAt.value;
    expect(hoisted.emittedAt.value).toBeGreaterThan(0);
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
  });
});
