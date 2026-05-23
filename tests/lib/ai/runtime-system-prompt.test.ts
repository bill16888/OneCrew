import '../../setup';

/**
 * @file Property tests for `runCycle` system-prompt + tool-surface +
 * round-cap invariants.
 *
 * Properties covered:
 *   - Property 11 (角色化 system prompt 注入): every Anthropic call
 *     issued for an AI with `aiRole = r` carries
 *     `system === SYSTEM_PROMPTS[r]`.
 *   - Property 22 (多轮上限与终止原因): when the model always returns
 *     `tool_use`, the runtime issues at most 5 calls and finishes
 *     with `finishReason = 'round_cap'`.
 *   - Property 17 partial (tool_result 完整回写): the round
 *     immediately following `k` `tool_use` blocks issues a request
 *     whose final user message contains exactly `k` `tool_result`
 *     blocks bijecting to those `tool_use` ids.
 *   - Property 24 partial (ai:thinking 配对广播): exactly one
 *     `ai:thinking { state: true }` precedes exactly one
 *     `ai:thinking { state: false }` per cycle.
 *
 * Validates: Requirements 4.2, 5.9, 7.3, 7.4, 7.6, 7.7
 *           (P2 tasks 6.6, 6.10, 6.9, 10.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { SYSTEM_PROMPTS } from '@/lib/ai/prompts';

interface RecordedCall {
  system: string;
  tools: unknown[];
  messages: unknown[];
}
interface CapturedEmit {
  event: string;
  payload: { aiUserId: string; state: boolean };
}

const hoisted = vi.hoisted(() => ({
  callsLog: [] as RecordedCall[],
  emitted: [] as CapturedEmit[],
  emittedRoom: { value: '' },
  aiUserRow: { value: null as { id: string; isAI: boolean; aiRole: string } | null },
  scriptedResponses: [] as Array<{
    stop_reason: string;
    content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
    usage: { input_tokens: number; output_tokens: number };
  }>,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findUniqueOrThrow: vi.fn(async () => hoisted.aiUserRow.value),
    },
    message: { findMany: vi.fn(async () => []) },
    task: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock('@/lib/realtime/io', () => ({
  getIO: () => ({
    to: (room: string) => {
      hoisted.emittedRoom.value = room;
      return {
        emit: (event: string, payload: CapturedEmit['payload']) => {
          if (event === 'ai:thinking') {
            hoisted.emitted.push({ event, payload });
          }
        },
      };
    },
  }),
}));

vi.mock('@/lib/ai/anthropic', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/anthropic')>(
    '@/lib/ai/anthropic',
  );
  return {
    ...actual,
    callAnthropicWithRetry: vi.fn(
      async (req: { system: string; tools: unknown[]; messages: unknown[] }) => {
        hoisted.callsLog.push({
          system: req.system,
          tools: req.tools,
          messages: req.messages,
        });
        const next = hoisted.scriptedResponses.shift();
        if (!next) {
          throw new Error('no scripted response left');
        }
        return next as never;
      },
    ),
  };
});

vi.mock('@/lib/ai/tools', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/tools')>(
    '@/lib/ai/tools',
  );
  return {
    ...actual,
    dispatchTool: vi.fn(async (_ctx: unknown, call: { id: string }) => ({
      tool_use_id: call.id,
      type: 'tool_result' as const,
      content: 'ok',
    })),
  };
});

import { runCycle } from '@/lib/ai/runtime';

beforeEach(() => {
  hoisted.callsLog.splice(0);
  hoisted.emitted.splice(0);
  hoisted.scriptedResponses.splice(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 11: 角色化 system prompt 注入', () => {
  it.each(['Ada', 'Hopper'] as const)(
    'role %s: every Anthropic call carries SYSTEM_PROMPTS[%s]',
    async (role) => {
      hoisted.aiUserRow.value = {
        id: `user_ai_${role.toLowerCase()}`,
        isAI: true,
        aiRole: role,
      };
      // Three rounds, all returning tool_use, then a stop. The exact
      // sequence is not what we check — only that every call shares
      // the same system prompt.
      for (let i = 0; i < 3; i++) {
        hoisted.scriptedResponses.push({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: `t_${i}`, name: 'mock_web_search', input: { query: 'q' } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      hoisted.scriptedResponses.push({
        stop_reason: 'end_turn',
        content: [{ type: 'text' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      await runCycle(`user_ai_${role.toLowerCase()}`);

      expect(hoisted.callsLog.length).toBeGreaterThan(0);
      for (const call of hoisted.callsLog) {
        expect(call.system).toBe(SYSTEM_PROMPTS[role]);
      }
    },
  );
});

describe('Feature: ai-native-team-workspace, Property 22: 多轮上限与终止原因', () => {
  it('caps at 5 rounds when the model always returns tool_use', async () => {
    hoisted.aiUserRow.value = {
      id: 'user_ai_ada',
      isAI: true,
      aiRole: 'Ada',
    };
    // Push 10 tool_use responses; the runtime should only consume 5.
    for (let i = 0; i < 10; i++) {
      hoisted.scriptedResponses.push({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: `tu_${i}`, name: 'mock_web_search', input: { query: 'q' } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    const result = await runCycle('user_ai_ada');
    expect(result.rounds).toBeLessThanOrEqual(5);
    expect(result.rounds).toBe(5);
    expect(result.finishReason).toBe('round_cap');
    expect(hoisted.callsLog).toHaveLength(5);
  });
});

describe('Feature: ai-native-team-workspace, Property 17 partial: tool_result 完整回写', () => {
  it('round n+1 carries one tool_result per tool_use in round n', async () => {
    hoisted.aiUserRow.value = {
      id: 'user_ai_ada',
      isAI: true,
      aiRole: 'Ada',
    };
    // Round 1 emits 3 parallel tool_use blocks.
    hoisted.scriptedResponses.push({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'mock_web_search', input: { query: 'q1' } },
        { type: 'tool_use', id: 'b', name: 'mock_web_search', input: { query: 'q2' } },
        { type: 'tool_use', id: 'c', name: 'mock_web_search', input: { query: 'q3' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    // Round 2: stop.
    hoisted.scriptedResponses.push({
      stop_reason: 'end_turn',
      content: [{ type: 'text' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await runCycle('user_ai_ada');

    expect(hoisted.callsLog).toHaveLength(2);
    const round2 = hoisted.callsLog[1];
    const lastUser = round2.messages[round2.messages.length - 1] as {
      role: 'user';
      content: Array<{ type: string; tool_use_id: string }>;
    };
    expect(lastUser.role).toBe('user');
    const ids = lastUser.content.map((b) => b.tool_use_id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    for (const block of lastUser.content) {
      expect(block.type).toBe('tool_result');
    }
  });
});

describe('Feature: ai-native-team-workspace, Property 24 partial: ai:thinking 配对广播', () => {
  it('emits exactly one true and one false per cycle', async () => {
    hoisted.aiUserRow.value = {
      id: 'user_ai_ada',
      isAI: true,
      aiRole: 'Ada',
    };
    hoisted.scriptedResponses.push({
      stop_reason: 'end_turn',
      content: [{ type: 'text' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await runCycle('user_ai_ada');
    expect(hoisted.emitted).toHaveLength(2);
    expect(hoisted.emitted[0].payload.state).toBe(true);
    expect(hoisted.emitted[1].payload.state).toBe(false);
  });
});
