import { KanbanBoard } from '@/components/board/KanbanBoard';
import type { TaskCardData } from '@/components/board/TaskCard';

/**
 * `/board` — the kanban view inside the `(workspace)` route group
 * (task 2.5).
 *
 * Static skeleton: the page hard-codes a small set of mock tasks so we
 * can demonstrate the visual contract end-to-end (Requirements 3.1,
 * 3.7, 9.3). The real data path lands in:
 *   - task 7.1 (`TaskService.list`)
 *   - task 7.4 (`GET /api/tasks`)
 *
 * Mock data covers each kanban column at least once and includes both
 * AI and human assignees so the AI Badge / gradient avatar treatment is
 * visible at a glance.
 */

const MOCK_TASKS: readonly TaskCardData[] = [
  {
    id: 'mock-1',
    taskId: 'PROJ-1',
    title: 'Draft onboarding flow for new team members',
    status: 'Backlog',
    priority: 'Medium',
    isAITask: false,
    assignee: {
      id: 'user-jane',
      name: 'Jane Doe',
      isAI: false,
    },
  },
  {
    id: 'mock-2',
    taskId: 'PROJ-2',
    title: 'Investigate flaky integration test in checkout',
    status: 'Backlog',
    priority: 'Low',
    isAITask: false,
    assignee: null,
  },
  {
    id: 'mock-3',
    taskId: 'PROJ-3',
    title: 'Summarize last week\u2019s engineering retro into action items',
    status: 'InProgress',
    priority: 'High',
    isAITask: true,
    assignee: {
      id: 'ai-ada',
      name: 'Ada',
      isAI: true,
    },
  },
  {
    id: 'mock-4',
    taskId: 'PROJ-4',
    title: 'Refactor message metadata serialization',
    status: 'InProgress',
    priority: 'Medium',
    isAITask: false,
    assignee: {
      id: 'user-marc',
      name: 'Marc Tan',
      isAI: false,
    },
  },
  {
    id: 'mock-5',
    taskId: 'PROJ-5',
    title: 'Review proposal: realtime channel auth middleware',
    status: 'InReview',
    priority: 'Urgent',
    isAITask: true,
    assignee: {
      id: 'ai-hopper',
      name: 'Hopper',
      isAI: true,
    },
  },
  {
    id: 'mock-6',
    taskId: 'PROJ-6',
    title: 'Ship dark-theme tokens across shared components',
    status: 'Done',
    priority: 'Low',
    isAITask: false,
    assignee: {
      id: 'user-sam',
      name: 'Sam Patel',
      isAI: false,
    },
  },
];

export default function BoardPage() {
  return (
    <div className="flex h-full w-full flex-col gap-6 px-8 py-8">
      <header className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Tasks
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Kanban board
        </h1>
        <p className="text-sm text-muted-foreground">
          Backlog, In Progress, In Review, Done. AI-driven tasks are tagged
          with the purple AI badge.
        </p>
      </header>

      <KanbanBoard tasks={MOCK_TASKS} className="min-h-0 flex-1" />
    </div>
  );
}
