import '../../setup';

/**
 * @file Property 15 — send_channel_message 工具的发送者归属。
 *
 * 当 dispatchTool(ctx, { name: 'send_channel_message', ... }) 被调用时,
 * 转交给 MessageService.create 的参数必须满足:
 *   - userId === ctx.aiUserId  (而不是工具 input 里的任何字段)
 *   - channelId / content 与 input 完全一致
 *
 * 这是 AI 不能 "假冒" 任意 user 发消息的核心防线 (Requirements 5.7,
 * 4.4，任务 7.11)。
 *
 * Validates: Requirements 5.7, 4.4 (P2 task 7.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

const hoisted = vi.hoisted(() => ({
  capturedArgs: [] as Array<{
    channelId: string;
    userId: string;
    content: string;
  }>,
  messageCreate: vi.fn(
    async (args: { channelId: string; userId: string; content: string }) => {
      hoisted.capturedArgs.push({ ...args });
      return {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        channelId: args.channelId,
        userId: args.userId,
        content: args.content,
        metadata: null,
        createdAt: new Date(),
      };
    },
  ),
}));

// MessageService 是 dispatchTool 内部 send_channel_message 分支的下游。
// 我们只 mock MessageService.create，让其他工具分支保留真实实现 (它们
// 不依赖 MessageService)。
vi.mock('@/lib/services/message.service', () => ({
  MessageService: {
    create: hoisted.messageCreate,
    listByChannel: vi.fn(async () => []),
  },
  MESSAGE_MAX_LENGTH: 8000,
  ValidationError: class extends Error {},
}));

// 不让 dispatchTool 内的 ApprovalService / TaskService 副作用真的执行
vi.mock('@/lib/services/approval.service', () => ({
  ApprovalService: { create: vi.fn(async () => ({ id: 'noop' })) },
}));
vi.mock('@/lib/services/task.service', () => ({
  TaskService: {
    create: vi.fn(async () => ({ taskId: 'PROJ-1', title: 'noop' })),
    updateStatus: vi.fn(async () => ({ taskId: 'PROJ-1', status: 'Backlog' })),
  },
  TASK_STATUSES: ['Backlog', 'InProgress', 'InReview', 'Done'] as const,
  ValidationError: class extends Error {},
}));

import { dispatchTool } from '@/lib/ai/tools';

beforeEach(() => {
  hoisted.capturedArgs.splice(0);
  hoisted.messageCreate.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 15: send_channel_message 发送者归属', () => {
  it('转交给 MessageService.create 的 userId 始终等于 ctx.aiUserId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 3, maxLength: 30 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 3, maxLength: 30 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (ctxAiUserId, channelId, content) => {
          hoisted.capturedArgs.splice(0);

          const result = await dispatchTool(
            { aiUserId: ctxAiUserId },
            {
              id: 'tu_1',
              name: 'send_channel_message',
              input: { channelId, content },
            },
          );

          // 1) 工具结果不应被标 is_error
          expect(result.is_error ?? false).toBe(false);

          // 2) MessageService.create 被调用了恰好一次
          expect(hoisted.capturedArgs).toHaveLength(1);

          // 3) 关键属性: userId === ctx.aiUserId
          expect(hoisted.capturedArgs[0].userId).toBe(ctxAiUserId);

          // 4) channelId / content 与 input 完全一致
          expect(hoisted.capturedArgs[0].channelId).toBe(channelId);
          expect(hoisted.capturedArgs[0].content).toBe(content);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('即使 input 里出现了 "userId" 字段，dispatcher 仍然只会用 ctx.aiUserId', async () => {
    // 注意: TOOL_ZOD_SCHEMAS.send_channel_message 不允许 userId 这个 key,
    // 但 zod 默认是 strip 而不是 strict，会把无关字段丢弃后通过校验。
    // 我们靠这条测试明确这个行为：模型即使尝试附带 userId 也无效。
    hoisted.capturedArgs.splice(0);
    const result = await dispatchTool(
      { aiUserId: 'user_ai_ada' },
      {
        id: 'tu_2',
        name: 'send_channel_message',
        input: {
          channelId: 'chan_general',
          content: 'hi',
          // attempt to spoof: ↓ 这个字段必须被忽略
          userId: 'user_human_admin',
        } as unknown as Record<string, string>,
      },
    );
    expect(result.is_error ?? false).toBe(false);
    expect(hoisted.capturedArgs).toHaveLength(1);
    expect(hoisted.capturedArgs[0].userId).toBe('user_ai_ada');
  });
});
