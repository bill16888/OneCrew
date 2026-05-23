import '../../setup';

/**
 * @file Property test for tick-level fault isolation.
 *
 * Property 29 (tick 异常隔离): a single AI's failure does not
 * propagate to its peers within the same tick, and a thrown tick
 * does not stop the next scheduled tick. We exercise the per-AI
 * isolation directly via the wakeup channel because the
 * `setInterval`-driven path is best validated separately under
 * fake timers (covered by the agentic-loop-gate spec for the
 * scheduling semantics).
 *
 * Validates: Requirement 10.6 (P2 task 10.5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agenticEmitter } from '@/lib/loop/emitter';

const hoisted = vi.hoisted(() => ({
  runCycleCalls: [] as string[],
  runCycleMock: vi.fn(async (aiUserId: string) => {
    hoisted.runCycleCalls.push(aiUserId);
    if (aiUserId === 'user_ai_throws') {
      throw new Error('cycle blew up');
    }
    return {
      aiUserId,
      rounds: 1,
      finishReason: 'stop' as const,
      durationMs: 1,
    };
  }),
}));

vi.mock('@/lib/ai/runtime', () => ({
  AIRuntime: { runCycle: hoisted.runCycleMock },
}));

vi.mock('@/lib/services/approval.service', () => ({
  ApprovalService: { listPendingForAI: vi.fn(async () => []) },
}));

vi.mock('@/lib/prisma', () => ({
  default: { user: { findMany: vi.fn(async () => []) } },
}));

vi.mock('@/lib/realtime/io', () => ({ getIO: () => null }));

import { AgenticLoop } from '@/lib/loop/agentic-loop';

beforeEach(() => {
  hoisted.runCycleCalls.splice(0);
  hoisted.runCycleMock.mockClear();
  AgenticLoop.start({} as never);
});

afterEach(() => {
  AgenticLoop.stop();
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 29: tick 异常隔离', () => {
  it('one AI throwing does not stop subsequent invocations for others', async () => {
    agenticEmitter.emit('wakeup', 'user_ai_throws');
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
    }
    // The runtime threw, but the loop swallowed it — emitting a
    // wakeup for a different AI right after must still work.
    agenticEmitter.emit('wakeup', 'user_ai_ada');
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(hoisted.runCycleCalls).toEqual([
      'user_ai_throws',
      'user_ai_ada',
    ]);
  });
});
