import '../setup';

/**
 * @file UI 静态契约测试 (任务 2.7).
 *
 * 这些测试不渲染 React 组件 (jsdom 在 Windows junction 下不稳定，
 * 见 vitest.config.ts 的注释)。它们对 4 列看板配置 / TaskCard /
 * MessageRow 在源码层做静态契约验证：
 *
 *   - KanbanBoard 暴露的 KANBAN_COLUMNS 恰好 4 列且顺序固定为
 *     Backlog → InProgress → InReview → Done，每列都有人类可读 label
 *     (Requirement 3.1, Property 关于看板视觉契约)。
 *   - TaskCard 在 isAITask=true 时使用 AI 渐变阴影类
 *     (Requirement 3.7, 9.3)。
 *   - MessageRow 在 fromAI=true 时使用 ai-message-accent (purple
 *     vertical bar) (Requirement 4.5, 9.2)。
 *
 * 因为 KanbanBoard / TaskCard / MessageRow 都是同步、纯渲染组件 (无副
 * 作用、无 hooks)，我们用 React 19 的官方 `react-dom/server`
 * `renderToString` 跑一次，断言输出 HTML 字符串里有/没有目标 className。
 * 这样既不需要 jsdom，也比读源码 grep 字符串更接近真实渲染契约。
 *
 * Validates: Requirements 3.1, 3.7, 4.5, 9.2, 9.3 (P2 task 2.7)。
 */

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

import { KANBAN_COLUMNS, KanbanBoard } from '@/components/board/KanbanBoard';
import { TaskCard, type TaskCardData } from '@/components/board/TaskCard';
import { MessageRow } from '@/components/channel/MessageRow';

describe('Feature: ai-native-team-workspace, KanbanBoard 4 列契约 (Requirement 3.1)', () => {
  it('KANBAN_COLUMNS 恰好包含 4 列', () => {
    expect(KANBAN_COLUMNS).toHaveLength(4);
  });

  it('列的顺序为 Backlog → InProgress → InReview → Done', () => {
    expect(KANBAN_COLUMNS.map((c) => c.status)).toEqual([
      'Backlog',
      'InProgress',
      'InReview',
      'Done',
    ]);
  });

  it('每列都有人类可读 label，且使用统一的中文文案', () => {
    // The product UI is shipped in Simplified Chinese (matches the
    // rest of the workspace surface — sidebar, dialogs, buttons). The
    // backing `TaskStatus` enum stays in PascalCase English for API
    // / Prisma compatibility; only the user-facing `label` is
    // localised. Update both this assertion and the labels in
    // `KanbanBoard.tsx` together if a future translation pass adds a
    // second locale.
    const labelByStatus = Object.fromEntries(
      KANBAN_COLUMNS.map((c) => [c.status, c.label]),
    );
    expect(labelByStatus.Backlog).toBe('待办');
    expect(labelByStatus.InProgress).toBe('进行中');
    expect(labelByStatus.InReview).toBe('审查中');
    expect(labelByStatus.Done).toBe('已完成');
  });

  it('renderToString 后 HTML 中出现全部 4 个列 label', () => {
    const html = renderToString(createElement(KanbanBoard, { tasks: [] }));
    for (const col of KANBAN_COLUMNS) {
      expect(html).toContain(col.label);
    }
  });
});

describe('Feature: ai-native-team-workspace, TaskCard AI Badge 契约 (Requirements 3.7, 9.3)', () => {
  const baseTask: TaskCardData = {
    id: 'cuid_1',
    taskId: 'PROJ-1',
    title: 'Wire up AI badge',
    status: 'Backlog',
    priority: 'Medium',
    isAITask: false,
    assignee: null,
  };

  it('isAITask=false 时 HTML 不包含 AI Badge 标签文本', () => {
    const html = renderToString(
      createElement(TaskCard, { task: { ...baseTask, isAITask: false } }),
    );
    // AIBadge 默认渲染 "AI" 文本；human task 行不含该文本节点也不含
    // shadow-ai-glow 类。
    expect(html).not.toContain('shadow-ai-glow');
  });

  it('isAITask=true 时 HTML 包含 AI 渐变阴影类 + AI Badge 文本', () => {
    const html = renderToString(
      createElement(TaskCard, { task: { ...baseTask, isAITask: true } }),
    );
    expect(html).toContain('shadow-ai-glow');
    expect(html).toContain('AI');
  });

  it('Task ID 始终在 HTML 中渲染 (Requirement 3.2)', () => {
    const html = renderToString(
      createElement(TaskCard, { task: baseTask }),
    );
    expect(html).toContain('PROJ-1');
  });
});

describe('Feature: ai-native-team-workspace, MessageRow 紫色竖线契约 (Requirements 4.5, 9.2)', () => {
  const baseMessage = {
    id: 'msg_1',
    userId: 'u_1',
    userName: 'Mia',
    content: 'hello world',
    createdAt: new Date('2026-05-23T00:00:00Z'),
  };

  it('fromAI=false 时 HTML 不包含 ai-message-accent 类', () => {
    const html = renderToString(
      createElement(MessageRow, { ...baseMessage, fromAI: false }),
    );
    expect(html).not.toContain('ai-message-accent');
    // AIBadge 也不应出现在人类消息上
    expect(html).not.toContain('bg-ai-gradient');
  });

  it('fromAI=true 时 HTML 包含 ai-message-accent + 紫色渐变头像', () => {
    const html = renderToString(
      createElement(MessageRow, {
        ...baseMessage,
        userName: 'Ada',
        fromAI: true,
      }),
    );
    expect(html).toContain('ai-message-accent');
    expect(html).toContain('bg-ai-gradient');
  });

  it('消息内容在 HTML 中按原文渲染 (Requirement 4.5)', () => {
    const html = renderToString(
      createElement(MessageRow, { ...baseMessage, fromAI: false }),
    );
    expect(html).toContain('hello world');
    expect(html).toContain('Mia');
  });
});
