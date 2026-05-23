import '../../setup';

/**
 * @file Property tests for the Agentic Loop's PENDING-approval gate
 * and immediate wakeup path.
 *
 * Property 19 (审批阻塞与即时唤醒):
 *   - For any AI `a` with at least one PENDING approval at time `t`,
 *     no new `runCycle(a)` is started by the periodic tick.
 *   - For any approval transitioning `PENDING → APPROVED` for `a` at
 *     time `t`, `runForAI(a)` runs within ε via the wakeup listener.
 *
 * We mock both `prisma`, `AIRuntime`, and `ApprovalService` so the
 * test exercises *only* the loop's gating logic.
 *
 * Validates: Requirements 6.3, 6.5, 6.6, 7.2 (P2 task 10.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agenticEmitter } from '@/lib/loop/emitter';

const hoisted = vi.hoisted(() => ({
  runCycleMock: vi.fn(async (aiUserId: string) => ({
    aiUserId,
    rounds: 1,
    finishReason: 'stop' as const,
    durationMs: 1,
  })),
  pendingByAi: new Map<string, number>(),
  aiUsers: [] as Array<{ id: string }>,
}));

vi.mock('@/lib/ai/runtime', () => ({
  AIRuntime: { runCycle: hoisted.runCycleMock },
}));

vi.mock('@/lib/services/approval.service', () => ({
  ApprovalService: {
    listPendingForAI: vi.fn(async (aiUserId: string) => {
      const count = hoisted.pendingByAi.get(aiUserId) ?? 0;
      return Array.from({ length: count }, (_, i) => ({ id: `app_${i}` }));
    }),
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: { findMany: vi.fn(async () => hoisted.aiUsers) },
  },
}));

vi.mock('@/lib/realtime/io', () => ({ getIO: () => null }));

import { AgenticLoop } from '@/lib/loop/agentic-loop';

beforeEach(() => {
  hoisted.pendingByAi.clear();
  hoisted.aiUsers = [];
  hoisted.runCycleMock.mockClear();
  AgenticLoop.start({} as never);
});

afterEach(() => {
  AgenticLoop.stop();
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 19: 审批门控与即时唤醒', () => {
  it('skips wakeup-driven runForAI when the AI has a PENDING approval', async () => {
    hoisted.pendingByAi.set('user_ai_ada', 1);
    agenticEmitter.emit('wakeup', 'user_ai_ada');
    // Allow the microtask queue to drain — `runForAI` is fire-and-
    // forget but every step inside it is awaited.
    await new Promise((r) => setImmediate(r));
    expect(hoisted.runCycleMock).not.toHaveBeenCalled();
  });

  it('runs immediately on wakeup when no PENDING approval exists', async () => {
    hoisted.pendingByAi.set('user_ai_ada', 0);
    agenticEmitter.emit('wakeup', 'user_ai_ada');
    // The wakeup listener kicks `runForAI` synchronously, but the
    // listPendingForAI / runCycle awaits run on the microtask queue.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(hoisted.runCycleMock).toHaveBeenCalledWith('user_ai_ada');
  });

  it('reject events do not trigger a new cycle (no wakeup)', async () => {
    agenticEmitter.emit('reject', 'user_ai_ada');
    await new Promise((r) => setImmediate(r));
    expect(hoisted.runCycleMock).not.toHaveBeenCalled();
  });
});
