import '../../setup';

/**
 * @file Tests for the AI daily-report scheduler (Phase 1 Req 15).
 *
 * The model-call path (runCycle) is mocked so these tests exercise the
 * scheduler's own logic: budget gating (Req 15.3), sequential batch
 * processing, failure isolation (Req 15.5), and the disabled / invalid
 * cron guards (Req 15.1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  shouldPause: { value: false },
  runCycle: vi.fn(),
  aiUsers: [] as Array<{ id: string; name: string }>,
  cronValidate: vi.fn((_expr: string) => true),
  cronSchedule: vi.fn(() => ({ stop: vi.fn() })),
  enabled: { value: true },
}));

vi.mock('@/lib/ai/runtime', () => ({
  AIRuntime: {
    runCycle: hoisted.runCycle,
  },
}));

vi.mock('@/lib/ai/budget', () => ({
  budget: {
    shouldPauseCycle: () => hoisted.shouldPause.value,
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findMany: vi.fn(async () => hoisted.aiUsers),
    },
  },
}));

vi.mock('node-cron', () => ({
  default: {
    validate: hoisted.cronValidate,
    schedule: hoisted.cronSchedule,
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    get DAILY_REPORTS_ENABLED() {
      return hoisted.enabled.value;
    },
    DAILY_REPORT_CRON: '0 18 * * *',
    WORKSPACE_TZ: 'Asia/Shanghai',
    WORKSPACE_ID: 'ws_default',
  },
}));

import {
  runDailyReportOnce,
  runReportForAI,
  startDailyReportScheduler,
} from '@/lib/reports/daily';

beforeEach(() => {
  hoisted.shouldPause.value = false;
  hoisted.runCycle.mockReset();
  hoisted.runCycle.mockResolvedValue({
    aiUserId: 'x',
    rounds: 1,
    finishReason: 'stop',
    durationMs: 1,
  });
  hoisted.aiUsers = [
    { id: 'user_ai_1', name: 'Architect' },
    { id: 'user_ai_2', name: 'Coordinator' },
  ];
  hoisted.cronValidate.mockReturnValue(true);
  hoisted.cronSchedule.mockClear();
  hoisted.enabled.value = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runReportForAI', () => {
  it('runs a cycle with the daily-report instruction and reports completed', async () => {
    const result = await runReportForAI('user_ai_1', 'Architect');
    expect(result.status).toBe('completed');
    expect(hoisted.runCycle).toHaveBeenCalledOnce();
    const [, options] = hoisted.runCycle.mock.calls[0];
    expect(options.extraInstruction).toContain('每日工作汇报');
    expect(options.extraInstruction).toContain('send_channel_message');
  });

  it('skips without a model call when the budget is paused (Req 15.3)', async () => {
    hoisted.shouldPause.value = true;
    const result = await runReportForAI('user_ai_1', 'Architect');
    expect(result.status).toBe('skipped_budget');
    expect(hoisted.runCycle).not.toHaveBeenCalled();
  });

  it('returns failed (not throws) when runCycle throws (Req 15.5)', async () => {
    hoisted.runCycle.mockRejectedValueOnce(new Error('unknown AI'));
    const result = await runReportForAI('user_ai_1', 'Architect');
    expect(result.status).toBe('failed');
  });
});

describe('runDailyReportOnce', () => {
  it('runs a report for every active AI', async () => {
    const results = await runDailyReportOnce();
    expect(results).toHaveLength(2);
    expect(hoisted.runCycle).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
  });

  it('stops spending once the budget trips mid-batch', async () => {
    // First AI completes, then budget trips for the second.
    hoisted.shouldPause.value = false;
    hoisted.runCycle.mockImplementationOnce(async () => {
      hoisted.shouldPause.value = true; // trip after the first cycle
      return { aiUserId: 'x', rounds: 1, finishReason: 'stop', durationMs: 1 };
    });
    const results = await runDailyReportOnce();
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('skipped_budget');
    expect(hoisted.runCycle).toHaveBeenCalledOnce();
  });
});

describe('startDailyReportScheduler', () => {
  it('schedules a cron job when enabled with a valid expression', () => {
    const handle = startDailyReportScheduler();
    expect(hoisted.cronSchedule).toHaveBeenCalledOnce();
    expect(typeof handle.stop).toBe('function');
  });

  it('no-ops when DAILY_REPORTS_ENABLED is false', () => {
    hoisted.enabled.value = false;
    const handle = startDailyReportScheduler();
    expect(hoisted.cronSchedule).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  it('no-ops on an invalid cron expression', () => {
    hoisted.cronValidate.mockReturnValue(false);
    const handle = startDailyReportScheduler();
    expect(hoisted.cronSchedule).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });
});
