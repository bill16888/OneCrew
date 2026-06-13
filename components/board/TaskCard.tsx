import { AIBadge } from '@/components/ui/AIBadge';
import { cn } from '@/lib/utils';

/**
 * TaskCard — single card on the kanban board (task 2.5).
 *
 * Visual contract (Requirements 3.7, 9.3):
 *   - Top row: priority color block, Task_ID (`PROJ-{N}`), AI Badge when
 *     `isAITask = true`.
 *   - Title: 2-line clamp, foreground color.
 *   - Footer: circular assignee avatar (initials when no `avatarUrl`)
 *     plus the assignee display name. When unassigned, the footer shows
 *     a muted "Unassigned" label.
 *
 * Static skeleton: this component renders pre-built `TaskCardData`
 * objects only. The real task pipeline lands in tasks 7.1 / 7.4.
 */

/**
 * The 4 fixed kanban statuses (Requirement 3.1). The literal-union
 * mirrors the design.md `TaskStatus` and the real `Task` row shape
 * returned by `TaskService.list()`.
 */
export type TaskStatus = 'Backlog' | 'InProgress' | 'InReview' | 'Done';

/**
 * Priority levels surfaced on the card. Each level maps to one of the
 * four design tokens called out in task 2.5
 * (`destructive` / `warning` / `primary` / `muted`).
 */
export type TaskPriority = 'Urgent' | 'High' | 'Medium' | 'Low';

/** Minimal assignee shape needed for the card footer. */
export interface TaskAssignee {
  id: string;
  name: string;
  /** Optional avatar URL — when absent, the card falls back to initials. */
  avatarUrl?: string | null;
  /** Mirrors `User.isAI` from the design's data model. */
  isAI?: boolean;
}

/** Card-level task projection. */
export interface TaskCardData {
  /** Database id (cuid) — used as the React key by the parent column. */
  id: string;
  /** Human-readable task id, format `PROJ-{N}` (Requirement 3.2). */
  taskId: string;
  /** Task title shown as the card body. */
  title: string;
  /** Which column this task belongs in. */
  status: TaskStatus;
  /** Priority drives the small color block on the top-left of the card. */
  priority: TaskPriority;
  /** Whether the task was created by, or is assigned to, an AI colleague. */
  isAITask: boolean;
  /** Assignee details, or `null` when the task is unassigned. */
  assignee: TaskAssignee | null;
}

export interface TaskCardProps {
  task: TaskCardData;
  className?: string;
}

/**
 * Tailwind class for the small priority swatch in the card header.
 *
 * Mapping (per task 2.5):
 *   Urgent → destructive (red)
 *   High   → warning     (amber — Tailwind doesn't ship a `warning`
 *                         token in this project, so we use `bg-amber-500`
 *                         for visual parity)
 *   Medium → primary     (indigo)
 *   Low    → muted       (zinc)
 */
const PRIORITY_SWATCH_CLASS: Record<TaskPriority, string> = {
  Urgent: 'bg-destructive',
  High: 'bg-amber-500',
  Medium: 'bg-primary',
  Low: 'bg-muted-foreground/40',
};

/** Human-readable priority label for screen readers / tooltips. */
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  Urgent: 'Urgent priority',
  High: 'High priority',
  Medium: 'Medium priority',
  Low: 'Low priority',
};

/**
 * Derive the avatar initials.
 *
 * "Ada Lovelace"  → "AL"
 * "Hopper"        → "H"
 * "  jane doe"    → "JD"
 * ""              → "?"
 *
 * Keeps to at most two characters so the round chip stays balanced.
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

export function TaskCard({ task, className }: TaskCardProps) {
  const { taskId, title, priority, isAITask, assignee } = task;

  return (
    <article
      data-testid="task-card"
      data-task-id={taskId}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3 shadow-sm transition-colors',
        'hover:border-primary/50 hover:bg-surface-overlay',
        // AI tasks get the subtle purple glow used elsewhere for AI
        // affordances (Requirement 9.3).
        isAITask && 'shadow-ai-glow',
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <span
          aria-label={PRIORITY_LABEL[priority]}
          title={PRIORITY_LABEL[priority]}
          className={cn(
            'h-2.5 w-2.5 shrink-0 rounded-full',
            PRIORITY_SWATCH_CLASS[priority],
          )}
        />
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {taskId}
        </span>
        {isAITask && <AIBadge className="ml-auto" />}
      </header>

      <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {title}
      </p>

      <footer className="flex items-center gap-2 pt-1">
        {assignee ? (
          <AssigneeChip assignee={assignee} />
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        )}
      </footer>
    </article>
  );
}

interface AssigneeChipProps {
  assignee: TaskAssignee;
}

function AssigneeChip({ assignee }: AssigneeChipProps) {
  const initials = getInitials(assignee.name);
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white',
          // AI assignees reuse the purple gradient for visual coherence
          // with the AI Badge; humans get the Indigo primary accent.
          assignee.isAI ? 'bg-ai-gradient' : 'bg-primary',
        )}
      >
        {initials}
      </span>
      <span className="truncate text-foreground/80">{assignee.name}</span>
    </span>
  );
}
