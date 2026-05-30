import '../../../setup';

/**
 * @file Tests for the `assign_task` dispatcher branch (direction D,
 * Req 21 — AI task hand-off, the only wake-bearing tool).
 *
 * TaskService is mocked at the boundary (resolution + assignment); the
 * wake-chain peek/derive helpers and `env` are real so we exercise the
 * actual loop-prevention prediction and the AI_HANDOFF_ENABLED gate.
 * The real agenticEmitter is spied on (no AgenticLoop is started here,
 * so the emit is a no-op aside from the spy).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/task.service', () => ({
  TaskService: {
    create: vi.fn(),
    updateStatus: vi.fn(),
    list: vi.fn(),
    resolveTeammate: vi.fn(),
    summarizeForAI: vi.fn(),
    resolveHandoffTarget: vi.fn(),
    assign: vi.fn(),
  },
}));

vi.mock('@/lib/services/message.service', () => ({
  MessageService: { create: vi.fn(), listByChannel: vi.fn() },
  ValidationError: class ValidationError extends Error {},
}));

vi.mock('@/lib/services/approval.service', () => ({
  ApprovalService: {
    create: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    listPendingForAI: vi.fn(async () => []),
    isStale: vi.fn(() => false),
  },
}));

// Mock the emitter so we can assert hand-off wakes. wake-chain.ts does
// NOT import the emitter, so peekWake / deriveChildContext stay real.
vi.mock('@/lib/loop/emitter', () => ({
  agenticEmitter: {
    emit: vi.fn(() => true),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn(),
  },
}));

import { dispatchTool } from '@/lib/ai/tools';
import { env } from '@/lib/env';
import { agenticEmitter } from '@/lib/loop/emitter';
import {
  startHumanChain,
  __resetWakeChainsForTests,
  type WakeContext,
} from '@/lib/loop/wake-chain';
import { TaskService } from '@/lib/services/task.service';

const resolveHandoffTarget = vi.mocked(TaskService.resolveHandoffTarget);
const assign = vi.mocked(TaskService.assign);
const emit = vi.mocked(agenticEmitter.emit);

const CALLER = 'ai_caller';
const TARGET = 'ai_target';
const HUMAN = 'user_human';

let handoffWasEnabled: boolean;

beforeEach(() => {
  handoffWasEnabled = env.AI_HANDOFF_ENABLED;
  env.AI_HANDOFF_ENABLED = true;
  __resetWakeChainsForTests();
  resolveHandoffTarget.mockReset();
  assign.mockReset();
  assign.mockResolvedValue({ taskId: 'PROJ-1' } as never);
  emit.mockClear();
  emit.mockReturnValue(true);
});

afterEach(() => {
  env.AI_HANDOFF_ENABLED = handoffWasEnabled;
  vi.clearAllMocks();
});

function dispatchAssign(
  input: Record<string, unknown>,
  ctxExtra: Partial<{ wakeContext: WakeContext; allowedTools: string[] }> = {},
) {
  return dispatchTool(
    { aiUserId: CALLER, ...ctxExtra },
    { id: 't1', name: 'assign_task', input },
  );
}

describe('assign_task — gating (Req 21.7, C4)', () => {
  it('returns is_error and does nothing when AI_HANDOFF_ENABLED is false', async () => {
    env.AI_HANDOFF_ENABLED = false;
    const result = await dispatchAssign(
      { taskId: 'PROJ-1', assigneeName: 'Hopper' },
      { wakeContext: startHumanChain(HUMAN) },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('AI hand-off is disabled');
    expect(resolveHandoffTarget).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('is gated by the per-AI toolSet whitelist before anything else', async () => {
    const result = await dispatchAssign(
      { taskId: 'PROJ-1', assigneeName: 'Hopper' },
      { wakeContext: startHumanChain(HUMAN), allowedTools: ['mock_web_search'] },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("Tool 'assign_task' is not enabled");
    expect(resolveHandoffTarget).not.toHaveBeenCalled();
  });

  it('returns is_error when neither assignee selector is provided', async () => {
    const result = await dispatchAssign(
      { taskId: 'PROJ-1' },
      { wakeContext: startHumanChain(HUMAN) },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('Invalid arguments');
    expect(resolveHandoffTarget).not.toHaveBeenCalled();
  });
});

describe('assign_task — resolution failures (Req 21.4)', () => {
  it('is_error when the teammate cannot be found', async () => {
    resolveHandoffTarget.mockResolvedValue({ ok: false, reason: 'not_found' });
    const result = await dispatchAssign(
      { taskId: 'PROJ-1', assigneeName: 'Ghost' },
      { wakeContext: startHumanChain(HUMAN) },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('No teammate AI found');
    expect(assign).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('is_error when the teammate shares no channel with the caller', async () => {
    resolveHandoffTarget.mockResolvedValue({
      ok: false,
      reason: 'not_shared_channel',
    });
    const result = await dispatchAssign(
      { taskId: 'PROJ-1', assigneeName: 'Hopper' },
      { wakeContext: startHumanChain(HUMAN) },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('does not share a channel');
    expect(assign).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('is_error and no assignment when handing off to yourself', async () => {
    resolveHandoffTarget.mockResolvedValue({ ok: true, id: CALLER, name: 'Self' });
    const result = await dispatchAssign(
      { taskId: 'PROJ-1', assigneeId: CALLER },
      { wakeContext: startHumanChain(HUMAN) },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('yourself');
    expect(assign).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('assign_task — successful hand-off (Req 21.2, 21.5, 21.6)', () => {
  it('assigns and wakes the teammate with a hop+1 child context', async () => {
    resolveHandoffTarget.mockResolvedValue({ ok: true, id: TARGET, name: 'Hopper' });
    const parent = startHumanChain(HUMAN); // hop 0
    const result = await dispatchAssign(
      { taskId: 'PROJ-1', assigneeName: 'Hopper' },
      { wakeContext: parent },
    );
    expect(result.is_error).toBeUndefined();
    expect(assign).toHaveBeenCalledWith('PROJ-1', TARGET);
    expect(emit).toHaveBeenCalledWith(
      'wakeup',
      TARGET,
      expect.objectContaining({
        chainId: parent.chainId,
        hop: 1,
        originUserId: HUMAN,
        fromAiUserId: CALLER,
      }),
    );
    expect(String(result.content)).toContain('woke them');
  });

  it('assigns but does not wake when the cycle has no human-rooted chain', async () => {
    resolveHandoffTarget.mockResolvedValue({ ok: true, id: TARGET, name: 'Hopper' });
    // No wakeContext on the dispatch ctx (e.g. an auto-tick cycle).
    const result = await dispatchAssign({ taskId: 'PROJ-1', assigneeName: 'Hopper' });
    expect(result.is_error).toBeUndefined();
    expect(assign).toHaveBeenCalledWith('PROJ-1', TARGET);
    expect(emit).not.toHaveBeenCalled();
    expect(String(result.content)).toContain('No wake sent');
  });

  it('assigns but reports a suppressed wake when the hop budget is exceeded', async () => {
    resolveHandoffTarget.mockResolvedValue({ ok: true, id: TARGET, name: 'Hopper' });
    // Parent already at the hop ceiling (default 6) → child hop 7 is over budget.
    const parent: WakeContext = {
      chainId: 'chain_deep',
      hop: 6,
      originUserId: HUMAN,
      fromAiUserId: 'ai_prev',
    };
    const result = await dispatchAssign(
      { taskId: 'PROJ-1', assigneeName: 'Hopper' },
      { wakeContext: parent },
    );
    expect(result.is_error).toBeUndefined();
    expect(assign).toHaveBeenCalledWith('PROJ-1', TARGET);
    expect(emit).not.toHaveBeenCalled();
    expect(String(result.content)).toContain('hop_budget');
    expect(String(result.content)).toContain('Do not retry');
  });
});
