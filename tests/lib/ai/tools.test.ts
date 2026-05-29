/**
 * @file Property tests for `lib/ai/tools/`.
 *
 * Covers:
 *   - Property 12 (工具表面恒等): TOOL_DEFINITIONS is exactly the
 *     6-tool set, in stable order.
 *   - Property 13 (工具调度全函数性): dispatchTool never throws and
 *     returns a `tool_result`; unknown tools and schema failures yield
 *     `is_error: true`.
 *   - Property 14 (Mock 工具的纯净性): the two mock tools are
 *     deterministic and do not touch fs / network.
 *
 * Validates: P2 tasks 6.7, 6.8, 7.10. Service-layer branches
 * (create_task / update_task_status / send_channel_message /
 * request_approval) are mocked at the module boundary so the tests
 * stay free of Prisma / Socket.io.
 */

import '../../setup';

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('@/lib/services/task.service', () => ({
  TaskService: {
    create: vi.fn(async () => ({
      taskId: 'PROJ-1',
      title: 'mocked',
    })),
    updateStatus: vi.fn(async () => ({
      taskId: 'PROJ-1',
      status: 'InProgress',
    })),
    list: vi.fn(async () => []),
  },
}));

vi.mock('@/lib/services/message.service', () => ({
  MessageService: {
    create: vi.fn(async () => ({
      id: 'msg_test',
      content: 'mocked',
    })),
    listByChannel: vi.fn(async () => []),
  },
  ValidationError: class ValidationError extends Error {},
}));

vi.mock('@/lib/services/approval.service', () => ({
  ApprovalService: {
    create: vi.fn(async () => ({ id: 'app_test', status: 'PENDING' })),
    approve: vi.fn(),
    reject: vi.fn(),
    listPendingForAI: vi.fn(async () => []),
    isStale: vi.fn(() => false),
  },
}));

import {
  dispatchTool,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  type ToolName,
} from '@/lib/ai/tools';
import {
  mockReadProjectDocs,
  mockWebSearch,
} from '@/lib/ai/tools/mocks';
import { ApprovalService } from '@/lib/services/approval.service';

const EXPECTED_TOOL_SET: readonly string[] = [
  'create_task',
  'update_task_status',
  'request_approval',
  'send_channel_message',
  'mock_web_search',
  'mock_read_project_docs',
  // Phase 1 Req 12: real read-only tools. Property 12 was amended in
  // .kiro/specs/phase-1-solo-os/requirements.md to read "exactly the
  // 8 tools declared in TOOL_DEFINITIONS"; this PR ships the first
  // of those (web_search). read_project_docs lands in the next PR.
  'web_search',
];

describe('Feature: ai-native-team-workspace, Property 12: 工具表面恒等', () => {
  it('exposes exactly the 7 expected tools as a set', () => {
    const names = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    expect(names).toEqual(new Set(EXPECTED_TOOL_SET));
    expect(TOOL_DEFINITIONS).toHaveLength(7);
    expect(TOOL_NAMES).toHaveLength(7);
  });

  it('every TOOL_DEFINITIONS entry has matching name in TOOL_NAMES', () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(TOOL_NAMES).toContain(def.name as ToolName);
    }
  });
});

describe('Feature: ai-native-team-workspace, Property 13: 工具调度的全函数性', () => {
  it('returns is_error=true for any tool name outside TOOL_NAMES', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((s) => !(EXPECTED_TOOL_SET as string[]).includes(s)),
        async (name) => {
          const result = await dispatchTool(
            { aiUserId: 'u_test' },
            { id: 't1', name, input: {} },
          );
          expect(result.type).toBe('tool_result');
          expect(result.tool_use_id).toBe('t1');
          expect(result.is_error).toBe(true);
          expect(String(result.content)).toContain('Unknown tool');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns is_error=true on schema mismatch for known tools', async () => {
    // `create_task` requires a non-empty `title`. Drive arbitrary
    // garbage payloads that should always fail the zod schema.
    const arbBadPayload = fc.oneof(
      fc.constant({}),
      fc.constant({ title: '' }),
      fc.constant({ title: 123 }),
      fc.constant({ wrongField: 'x' }),
    );
    await fc.assert(
      fc.asyncProperty(arbBadPayload, async (input) => {
        const result = await dispatchTool(
          { aiUserId: 'u_test' },
          { id: 't1', name: 'create_task', input },
        );
        expect(result.is_error).toBe(true);
        expect(String(result.content)).toContain('Invalid arguments');
      }),
      { numRuns: 50 },
    );
  });

  it('never throws regardless of input shape', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.anything(),
        async (name, input) => {
          // Wrap in a try so a regression that *does* throw fails
          // loudly with a descriptive message.
          let threw = false;
          try {
            await dispatchTool(
              { aiUserId: 'u_test' },
              { id: 'tx', name, input },
            );
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Feature: ai-native-team-workspace, request_approval enriched payload', () => {
  it('persists structured approval analysis for human review', async () => {
    const createApproval = vi.mocked(ApprovalService.create);
    createApproval.mockClear();

    const result = await dispatchTool(
      { aiUserId: 'user_ai_ada' },
      {
        id: 'approval_tool_1',
        name: 'request_approval',
        input: {
          action: 'create_task',
          payload: { title: '上线检查复盘' },
          reason: '需要 PM 确认任务范围和优先级。',
          analysis: {
            background: '用户要求创建上线复盘任务。',
            impactScope: '会在 Kanban Backlog 中新增一张任务卡。',
            riskLevel: 'medium',
            alternatives: '先在频道中询问 PM 任务优先级。',
          },
        },
      },
    );

    expect(result.is_error).toBeUndefined();
    expect(createApproval).toHaveBeenCalledWith({
      aiUserId: 'user_ai_ada',
      action: 'create_task',
      payload: {
        title: '上线检查复盘',
        reason: '需要 PM 确认任务范围和优先级。',
        approvalAnalysis: {
          background: '用户要求创建上线复盘任务。',
          impactScope: '会在 Kanban Backlog 中新增一张任务卡。',
          riskLevel: 'medium',
          alternatives: ['先在频道中询问 PM 任务优先级。'],
        },
      },
    });
  });
});

describe('Feature: ai-native-team-workspace, Property 14: Mock 工具的纯净性', () => {
  it('mockWebSearch is deterministic for any string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (q) => {
        expect(mockWebSearch(q)).toBe(mockWebSearch(q));
      }),
      { numRuns: 100 },
    );
  });

  it('mockReadProjectDocs is deterministic for any string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (p) => {
        expect(mockReadProjectDocs(p)).toBe(mockReadProjectDocs(p));
      }),
      { numRuns: 100 },
    );
  });
});



describe('Audit C4 — per-AI tool whitelist enforcement', () => {
  it('undefined allowedTools = full surface (Ada / Hopper backwards compat)', async () => {
    const result = await dispatchTool(
      { aiUserId: 'u_ada' },
      {
        id: 't1',
        name: 'mock_web_search',
        input: { query: 'hello' },
      },
    );
    expect(result.is_error).toBeUndefined();
  });

  it('empty allowedTools = full surface (back-compat for created custom AIs without locks)', async () => {
    const result = await dispatchTool(
      { aiUserId: 'u_custom', allowedTools: [] },
      {
        id: 't1',
        name: 'mock_web_search',
        input: { query: 'hello' },
      },
    );
    expect(result.is_error).toBeUndefined();
  });

  it('non-empty allowedTools rejects tools outside the whitelist with is_error', async () => {
    const result = await dispatchTool(
      { aiUserId: 'u_locked', allowedTools: ['mock_web_search'] },
      {
        id: 't1',
        name: 'create_task',
        input: { title: 'should not run' },
      },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("Tool 'create_task' is not enabled");
    expect(String(result.content)).toContain('Allowed: mock_web_search');
  });

  it('non-empty allowedTools admits whitelisted tools as usual', async () => {
    const result = await dispatchTool(
      { aiUserId: 'u_locked', allowedTools: ['mock_web_search'] },
      {
        id: 't1',
        name: 'mock_web_search',
        input: { query: 'allowed' },
      },
    );
    expect(result.is_error).toBeUndefined();
  });

  it('whitelist runs BEFORE schema validation (failure messages reflect the gate that fired first)', async () => {
    // create_task with a bad payload (empty title) AND not in the
    // whitelist — should hit the whitelist branch, not the schema
    // branch.
    const result = await dispatchTool(
      { aiUserId: 'u_locked', allowedTools: ['mock_web_search'] },
      {
        id: 't1',
        name: 'create_task',
        input: { title: '' },
      },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('not enabled');
    expect(String(result.content)).not.toContain('Invalid arguments');
  });
});

describe('Audit L8 — cyclic approval payload escalates to high', () => {
  it('returns approval result with risk=high when the model emits a self-referencing payload', async () => {
    const createApproval = vi.mocked(ApprovalService.create);
    createApproval.mockClear();

    // A payload with a self-referencing field. JSON.stringify throws
    // TypeError on cyclic structures, which the risk inferer catches
    // and turns into a 'high' classification BEFORE the keyword
    // matchers run.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    const result = await dispatchTool(
      { aiUserId: 'u_ada' },
      {
        id: 'cyclic_1',
        name: 'request_approval',
        input: {
          // 'notify_users' would normally infer 'medium' via the
          // /notify|send|message/ keyword arm. With a cyclic payload
          // we expect the cyclic branch to short-circuit to 'high'
          // BEFORE that arm runs.
          action: 'notify_users',
          payload: cyclic,
          reason: 'send a notification',
        },
      },
    );

    expect(result.is_error).toBeUndefined();
    expect(createApproval).toHaveBeenCalledTimes(1);
    const recorded = createApproval.mock.calls[0]?.[0]?.payload as
      | Record<string, unknown>
      | undefined;
    expect(recorded).toBeDefined();
    const analysis = recorded?.approvalAnalysis as
      | Record<string, unknown>
      | undefined;
    expect(analysis?.riskLevel).toBe('high');
  });

  it('keyword-driven risk still works for non-cyclic payloads', async () => {
    const createApproval = vi.mocked(ApprovalService.create);
    createApproval.mockClear();

    await dispatchTool(
      { aiUserId: 'u_ada' },
      {
        id: 'kw_1',
        name: 'request_approval',
        input: {
          action: 'delete_record',
          payload: { recordId: 42 },
          reason: 'cleanup task',
        },
      },
    );

    const recorded = createApproval.mock.calls[0]?.[0]?.payload as
      | Record<string, unknown>
      | undefined;
    const analysis = recorded?.approvalAnalysis as
      | Record<string, unknown>
      | undefined;
    expect(analysis?.riskLevel).toBe('high');
  });
});
