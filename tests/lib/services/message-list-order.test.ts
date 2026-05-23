import '../../setup';

/**
 * @file Property 2 — 频道消息按时间正序返回。
 *
 * MessageService.listByChannel(channelId) 必须把 prisma.message.findMany
 * 调用的 orderBy 设成 createdAt: 'asc'，并且把同步 mock 出的乱序输入
 * 还原成按 createdAt 升序的输出 (Requirement 2.2, 任务 3.10)。
 *
 * 我们从两个角度验证：
 *
 * 1. **静态契约**：通过 vi.fn 捕获 prisma.message.findMany 的调用参数，
 *    断言 where.channelId 与 orderBy.createdAt === 'asc' 一致。
 * 2. **行为属性**：当我们把 mock 设成"按调用 orderBy 实际排序" 时，
 *    无论输入怎么乱排，输出都按 createdAt 升序，并且和原集合是
 *    permutation 关系。
 *
 * Validates: Requirements 2.2 (P2 task 3.10).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

const hoisted = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    channelId: string;
    userId: string;
    content: string;
    createdAt: Date;
  }>,
  lastFindManyArgs: { value: null as unknown },
  findMany: vi.fn(
    async (args: {
      where: { channelId: string };
      orderBy: { createdAt: 'asc' | 'desc' };
    }) => {
      hoisted.lastFindManyArgs.value = args;
      const filtered = hoisted.rows.filter(
        (r) => r.channelId === args.where.channelId,
      );
      const sorted = [...filtered].sort((a, b) => {
        const cmp = a.createdAt.getTime() - b.createdAt.getTime();
        return args.orderBy.createdAt === 'asc' ? cmp : -cmp;
      });
      return sorted;
    },
  ),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    message: {
      findMany: hoisted.findMany,
      // create 不会被 listByChannel 调用，但 message.service 模块导入
      // 时不需要它存在；保留个 noop 防止其他文件复用此 mock 时炸掉。
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({ getIO: () => null }));

import { MessageService } from '@/lib/services/message.service';

beforeEach(() => {
  hoisted.rows.splice(0);
  hoisted.lastFindManyArgs.value = null;
  hoisted.findMany.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 2: 频道消息按时间正序返回', () => {
  it('listByChannel 调用 findMany 时 orderBy === { createdAt: "asc" }', async () => {
    await MessageService.listByChannel('chan_general');
    expect(hoisted.findMany).toHaveBeenCalledTimes(1);
    const args = hoisted.lastFindManyArgs.value as {
      where: { channelId: string };
      orderBy: { createdAt: 'asc' };
    };
    expect(args.where.channelId).toBe('chan_general');
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('对任意乱序输入，输出按 createdAt 严格升序，且与输入互为 permutation', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 1 ~ 12 条消息，时间戳唯一以避免 == 边界引起测试不确定性。
        fc
          .uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), {
            minLength: 1,
            maxLength: 12,
          })
          .map((tsList) =>
            tsList.map((ts, i) => ({
              id: `msg_${i}_${ts}`,
              channelId: 'chan_general',
              userId: 'u_test',
              content: `c_${ts}`,
              // 每个 ts 转成 Date，作为 createdAt
              createdAt: new Date(ts),
            })),
          ),
        async (rows) => {
          hoisted.rows.splice(0, hoisted.rows.length, ...rows);

          const out = await MessageService.listByChannel('chan_general');

          // (a) 严格升序 (我们的输入时间戳唯一，所以严格 < 而不是 ≤)
          for (let i = 1; i < out.length; i++) {
            expect(out[i].createdAt.getTime()).toBeGreaterThan(
              out[i - 1].createdAt.getTime(),
            );
          }

          // (b) 输出和输入是相同集合 (按 id 比较)。
          const inIds = new Set(rows.map((r) => r.id));
          const outIds = new Set(out.map((r) => r.id));
          expect(outIds.size).toBe(inIds.size);
          for (const id of inIds) {
            expect(outIds.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('不属于该频道的消息不被返回', async () => {
    hoisted.rows.push(
      {
        id: 'm_a',
        channelId: 'chan_general',
        userId: 'u',
        content: 'in',
        createdAt: new Date(1000),
      },
      {
        id: 'm_b',
        channelId: 'chan_engineering',
        userId: 'u',
        content: 'out',
        createdAt: new Date(2000),
      },
    );
    const out = await MessageService.listByChannel('chan_general');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('m_a');
  });
});
