import '../setup';

/**
 * @file 任务 1.4 — Seed 一致性 smoke 测试。
 *
 * 设计上 prisma/seed.ts 一被 import 就会立即创建 PrismaClient 并运行
 * main()。我们想在不连真实 PG 的前提下验证 seed 的"配置契约"——
 * 也就是它"打算"种入哪些用户 / 频道，验证：
 *   - 1 个 Workspace
 *   - 3 个 human user
 *   - 2 个 AI 用户 (Ada / Hopper)，isAI=true，aiRole 各异
 *   - #general 与 #engineering 两个默认频道
 *
 * 实现策略：在 import seed.ts 之前 mock PrismaClient，捕获所有 upsert
 * 调用，然后断言调用次数 + 关键字段值 (Requirements 1.6, 4.1, 4.3)。
 *
 * Validates: Requirements 1.6, 4.1, 4.3 (P2 task 1.4).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface UpsertCall {
  table: string;
  args: { where: Record<string, unknown>; create: Record<string, unknown> };
}

const hoisted = vi.hoisted(() => ({
  upserts: [] as UpsertCall[],
  disconnected: { value: false },
}));

vi.mock('@prisma/client', () => {
  // 简洁的 PrismaClient stub: 把所有 upsert 调用纪录下来，供测试断言。
  class FakePrismaClient {
    workspace = {
      upsert: vi.fn(async (args: UpsertCall['args']) => {
        hoisted.upserts.push({ table: 'workspace', args });
        return { id: args.where.id as string };
      }),
    };
    user = {
      upsert: vi.fn(async (args: UpsertCall['args']) => {
        hoisted.upserts.push({ table: 'user', args });
        return { id: 'user_x' };
      }),
      findMany: vi.fn(async () => [
        { id: 'user_x', isAI: false },
      ]),
    };
    channel = {
      upsert: vi.fn(async (args: UpsertCall['args']) => {
        hoisted.upserts.push({ table: 'channel', args });
        return { id: args.where.id as string };
      }),
    };
    channelMember = {
      upsert: vi.fn(async (args: UpsertCall['args']) => {
        hoisted.upserts.push({ table: 'channelMember', args });
        return {};
      }),
    };
    async $disconnect() {
      hoisted.disconnected.value = true;
    }
  }
  return { PrismaClient: FakePrismaClient };
});

// 先 mock，再 import seed.ts 触发它的 main() 执行
beforeAll(async () => {
  // seed.ts 在文件末尾立即 .then() / .catch() 触发了 main()，所以
  // 这里 await 一下 macrotask 队列以等异步初始化完成。
  await import('@/prisma/seed');
  // 等 seed 内部 .finally(() => prisma.$disconnect()) 走完
  await new Promise<void>((res) => setTimeout(res, 50));
});

afterAll(() => {
  // 不重置 hoisted: 其他测试文件不依赖此 module 内部状态
});

function selectByTable(table: string): UpsertCall[] {
  return hoisted.upserts.filter((c) => c.table === table);
}

describe('Feature: ai-native-team-workspace, Seed 一致性 (P2 task 1.4)', () => {
  it('恰好 upsert 1 个 Workspace', () => {
    expect(selectByTable('workspace')).toHaveLength(1);
  });

  it('恰好 upsert 3 个 human user (isAI=false, passwordHash 非 null)', () => {
    const users = selectByTable('user');
    const humans = users.filter((u) => u.args.create.isAI === false);
    expect(humans).toHaveLength(3);
    for (const h of humans) {
      expect(h.args.create.passwordHash).toBeTruthy();
      expect(h.args.create.aiRole).toBeNull();
    }
  });

  it('恰好 upsert 2 个 AI 用户 (isAI=true, passwordHash=null, aiRole 互异)', () => {
    const users = selectByTable('user');
    const ais = users.filter((u) => u.args.create.isAI === true);
    expect(ais).toHaveLength(2);
    for (const ai of ais) {
      expect(ai.args.create.passwordHash).toBeNull();
      expect(typeof ai.args.create.aiRole).toBe('string');
    }
    const roles = ais.map((a) => a.args.create.aiRole as string).sort();
    expect(roles).toEqual(['Ada', 'Hopper']);
  });

  it('恰好 upsert 2 个默认频道: #general 与 #engineering', () => {
    const channels = selectByTable('channel');
    expect(channels).toHaveLength(2);
    const names = channels.map((c) => c.args.create.name).sort();
    expect(names).toEqual(['engineering', 'general']);
  });

  it('PrismaClient 在 seed 末尾被 disconnect', () => {
    expect(hoisted.disconnected.value).toBe(true);
  });
});
