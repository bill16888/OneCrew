import '../../../setup';

/**
 * @file Tests for the `check_teammate_tasks` dispatcher branch
 * (direction D, Req 20).
 *
 * The service layer (resolution + summary) is mocked at the
 * TaskService boundary so these tests pin the TOOL contract: target
 * resolution by id / name, the "at least one selector" Zod refine,
 * the unknown-target -> is_error path, the per-AI whitelist gate
 * (audit C4), and the rendered summary text. No Prisma, no wakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/task.service', () => ({
  TaskService: {
    create: vi.fn(),
    updateStatus: vi.fn(),
    list: vi.fn(),
    resolveTeammate: vi.fn(),
    summarizeForAI: vi.fn(),
  },
}));

// MessageService / ApprovalService are imported by the tools module at
// load time; mock them so importing dispatchTool never pulls a live
// Prisma / Socket.io path into this isolated tool test.
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

import { dispatchTool } from '@/lib/ai/tools';
import { TaskService } from '@/lib/services/task.service';

const resolveTeammate = vi.mocked(TaskService.resolveTeammate);
const summarizeForAI = vi.mocked(TaskService.summarizeForAI);

beforeEach(() => {
  resolveTeammate.mockReset();
  summarizeForAI.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('check_teammate_tasks — dispatcher (Req 20)', () => {
  it('resolves the target by aiUserId and renders the summary', async () => {
    resolveTeammate.mockResolvedValue({ id: 'ai_ada', name: 'Ada' });
    summarizeForAI.mockResolvedValue({
      counts: { Backlog: 1, InProgress: 2, InReview: 0, Done: 3 },
      total: 6,
      recentlyUpdated: [
        { taskId: 'PROJ-9', title: '修复登录回归', status: 'Done' },
      ],
    });

    const result = await dispatchTool(
      { aiUserId: 'ai_hopper' },
      { id: 't1', name: 'check_teammate_tasks', input: { aiUserId: 'ai_ada' } },
    );

    expect(result.is_error).toBeUndefined();
    expect(resolveTeammate).toHaveBeenCalledWith({
      aiUserId: 'ai_ada',
      aiName: undefined,
    });
    expect(summarizeForAI).toHaveBeenCalledWith('ai_ada');
    const content = String(result.content);
    expect(content).toContain('Teammate Ada');
    expect(content).toContain('Backlog 1');
    expect(content).toContain('InProgress 2');
    expect(content).toContain('Done 3');
    expect(content).toContain('PROJ-9');
    expect(content).toContain('修复登录回归');
  });

  it('resolves the target by aiName', async () => {
    resolveTeammate.mockResolvedValue({ id: 'ai_ada', name: 'Ada' });
    summarizeForAI.mockResolvedValue({
      counts: { Backlog: 0, InProgress: 0, InReview: 0, Done: 0 },
      total: 0,
      recentlyUpdated: [],
    });

    const result = await dispatchTool(
      { aiUserId: 'ai_hopper' },
      { id: 't1', name: 'check_teammate_tasks', input: { aiName: 'Ada' } },
    );

    expect(result.is_error).toBeUndefined();
    expect(resolveTeammate).toHaveBeenCalledWith({
      aiUserId: undefined,
      aiName: 'Ada',
    });
    expect(String(result.content)).toContain('No tasks updated in the last 24h');
  });

  it('returns is_error when neither aiUserId nor aiName is provided', async () => {
    const result = await dispatchTool(
      { aiUserId: 'ai_hopper' },
      { id: 't1', name: 'check_teammate_tasks', input: {} },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('Invalid arguments');
    // The refine never reaches the service.
    expect(resolveTeammate).not.toHaveBeenCalled();
  });

  it('returns is_error when the target AI cannot be resolved', async () => {
    resolveTeammate.mockResolvedValue(null);
    const result = await dispatchTool(
      { aiUserId: 'ai_hopper' },
      { id: 't1', name: 'check_teammate_tasks', input: { aiName: 'Ghost' } },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('No teammate AI found');
    expect(summarizeForAI).not.toHaveBeenCalled();
  });

  it('is gated by the per-AI toolSet whitelist (audit C4)', async () => {
    const result = await dispatchTool(
      { aiUserId: 'ai_locked', allowedTools: ['mock_web_search'] },
      { id: 't1', name: 'check_teammate_tasks', input: { aiName: 'Ada' } },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("Tool 'check_teammate_tasks' is not enabled");
    expect(resolveTeammate).not.toHaveBeenCalled();
  });

  it('admits the tool when present in a non-empty whitelist', async () => {
    resolveTeammate.mockResolvedValue({ id: 'ai_ada', name: 'Ada' });
    summarizeForAI.mockResolvedValue({
      counts: { Backlog: 0, InProgress: 0, InReview: 0, Done: 0 },
      total: 0,
      recentlyUpdated: [],
    });
    const result = await dispatchTool(
      { aiUserId: 'ai_hopper', allowedTools: ['check_teammate_tasks'] },
      { id: 't1', name: 'check_teammate_tasks', input: { aiName: 'Ada' } },
    );
    expect(result.is_error).toBeUndefined();
  });

  it('never throws when the summary read fails (Property 13 totality)', async () => {
    resolveTeammate.mockResolvedValue({ id: 'ai_ada', name: 'Ada' });
    summarizeForAI.mockRejectedValue(new Error('db down'));
    const result = await dispatchTool(
      { aiUserId: 'ai_hopper' },
      { id: 't1', name: 'check_teammate_tasks', input: { aiName: 'Ada' } },
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('Tool execution failed');
  });
});
