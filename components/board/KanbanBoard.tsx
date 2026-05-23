import { TaskCard, type TaskCardData, type TaskStatus } from './TaskCard';
import { cn } from '@/lib/utils';

/**
 * KanbanBoard — the 4-column kanban surface (task 2.5).
 *
 * Layout contract (Requirements 3.1, 3.7):
 *   - Renders **exactly four** fixed columns in this order:
 *       Backlog → In Progress → In Review → Done
 *   - Each column header shows the human-readable column label and a
 *     small count chip with the number of tasks in that column.
 *   - Tasks are partitioned by `status`; tasks whose status doesn't
 *     match any of the four columns are dropped (defensive — should not
 *     occur because the type union restricts `status` to those values).
 *
 * Static skeleton: drag-and-drop is explicitly out of MVP scope, so
 * this component is read-only. The real `task:updated` realtime stream
 * is wired in tasks 3.x and 7.x.
 */

/** Internal column descriptor — `status` matches the literal union. */
interface KanbanColumn {
  status: TaskStatus;
  /** Display label rendered in the column header. Note that `InProgress`
   *  and `InReview` are deliberately split into "In Progress" /
   *  "In Review" for readability while the backing enum stays compact. */
  label: string;
}

/**
 * Fixed 4-column definition (Requirement 3.1). The order — and the
 * `length === 4` invariant — is part of the visual contract; tests in
 * task 2.7 assert this exact configuration.
 */
export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  { status: 'Backlog', label: 'Backlog' },
  { status: 'InProgress', label: 'In Progress' },
  { status: 'InReview', label: 'In Review' },
  { status: 'Done', label: 'Done' },
] as const;

export interface KanbanBoardProps {
  tasks: readonly TaskCardData[];
  className?: string;
}

export function KanbanBoard({ tasks, className }: KanbanBoardProps) {
  const tasksByStatus = groupTasksByStatus(tasks);

  return (
    <div
      data-testid="kanban-board"
      className={cn(
        'grid h-full w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4',
        className,
      )}
    >
      {KANBAN_COLUMNS.map((column) => (
        <KanbanColumnView
          key={column.status}
          column={column}
          tasks={tasksByStatus[column.status]}
        />
      ))}
    </div>
  );
}

interface KanbanColumnViewProps {
  column: KanbanColumn;
  tasks: readonly TaskCardData[];
}

function KanbanColumnView({ column, tasks }: KanbanColumnViewProps) {
  return (
    <section
      aria-label={`${column.label} column`}
      data-testid="kanban-column"
      data-status={column.status}
      className="flex h-full min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-3"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {column.label}
        </h3>
        <span
          aria-label={`${tasks.length} tasks`}
          className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          {tasks.length}
        </span>
      </header>

      <ul className="flex flex-col gap-2">
        {tasks.length === 0 ? (
          <li className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
            No tasks yet
          </li>
        ) : (
          tasks.map((task) => (
            <li key={task.id}>
              <TaskCard task={task} />
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

/**
 * Partition the incoming task list by status.
 *
 * Returns a record keyed by every `TaskStatus` (so column views can
 * read `tasksByStatus[col.status]` without nullish guards). Order
 * within each column preserves the input order — the parent decides
 * how to sort before passing tasks in.
 */
function groupTasksByStatus(
  tasks: readonly TaskCardData[],
): Record<TaskStatus, TaskCardData[]> {
  const buckets: Record<TaskStatus, TaskCardData[]> = {
    Backlog: [],
    InProgress: [],
    InReview: [],
    Done: [],
  };
  for (const task of tasks) {
    // The TaskStatus union restricts this at compile time; the lookup
    // is still safe at runtime because every union member is a key.
    buckets[task.status].push(task);
  }
  return buckets;
}
