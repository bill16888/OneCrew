'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import type { BoardUser } from '@/components/board/BoardView';
import { cn } from '@/lib/utils';

/**
 * Props for {@link NewTaskDialog}.
 *
 * The dialog is fully controlled by the parent: it does not own its
 * "open" state, only fires `onClose` when the user finishes a flow
 * (cancel, submit-success, or backdrop click). The board page passes
 * the same `assignableUsers` it loaded server-side so the dialog never
 * fans out into a separate fetch.
 */
export interface NewTaskDialogProps {
  /** Choices for the optional "Assignee" dropdown. */
  assignableUsers: readonly BoardUser[];
  /** Called when the dialog wants to be unmounted. */
  onClose: () => void;
}

interface FormState {
  title: string;
  description: string;
  assigneeId: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  assigneeId: '',
};

/**
 * Modal dialog that lets a human user create a task from the kanban
 * board.
 *
 * Workflow:
 *   1. User fills `title` (required), optionally `description`, and
 *      optionally picks an assignee from the dropdown.
 *   2. On submit the form POSTs `{ title, description?, assigneeId? }`
 *      to `/api/tasks`.
 *   3. On success the dialog closes immediately. The realtime
 *      `task:updated` broadcast emitted by `TaskService.create`
 *      delivers the card back to {@link BoardView} for everyone in the
 *      workspace, including the submitter.
 *   4. On failure (HTTP 4xx/5xx) the error message from the API is
 *      surfaced inline and the form stays open so the user can retry.
 *
 * Accessibility:
 *   - Focuses the title input on mount.
 *   - `Esc` and the backdrop click both close via `onClose`.
 *   - The submit button is disabled while the request is in-flight to
 *     prevent double-submission.
 */
export function NewTaskDialog({
  assignableUsers,
  onClose,
}: NewTaskDialogProps): JSX.Element {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleInputId = useId();
  const descInputId = useId();
  const assigneeInputId = useId();
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the title field on mount.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Close on Escape from anywhere inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    if (form.title.trim().length === 0) {
      setError('标题不能为空');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          description:
            form.description.trim().length > 0
              ? form.description.trim()
              : undefined,
          assigneeId:
            form.assigneeId.length > 0 ? form.assigneeId : undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? `创建失败 (HTTP ${res.status})`);
        return;
      }
      // Success — close immediately. The realtime broadcast from
      // `TaskService.create` will append the new card.
      onClose();
    } catch {
      setError('网络错误，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${titleInputId}-heading`}
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      {/* Backdrop. Tapping closes the dialog. */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <div
        className={cn(
          'relative z-10 flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-xl',
        )}
      >
        <header className="flex items-start justify-between gap-2">
          <h2
            id={`${titleInputId}-heading`}
            className="text-lg font-semibold text-foreground"
          >
            新建任务
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-raised hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={titleInputId}
              className="text-sm font-medium text-foreground"
            >
              标题
            </label>
            <input
              ref={titleRef}
              id={titleInputId}
              name="title"
              type="text"
              maxLength={200}
              required
              value={form.title}
              onChange={(e) =>
                setForm((s) => ({ ...s, title: e.target.value }))
              }
              placeholder="例如:写产品需求文档"
              className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={descInputId}
              className="text-sm font-medium text-foreground"
            >
              描述<span className="text-muted-foreground">(可选)</span>
            </label>
            <textarea
              id={descInputId}
              name="description"
              maxLength={2000}
              rows={3}
              value={form.description}
              onChange={(e) =>
                setForm((s) => ({ ...s, description: e.target.value }))
              }
              placeholder="补充背景、验收标准、关联链接..."
              className="resize-y rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={assigneeInputId}
              className="text-sm font-medium text-foreground"
            >
              指派<span className="text-muted-foreground">(可选)</span>
            </label>
            <select
              id={assigneeInputId}
              name="assigneeId"
              value={form.assigneeId}
              onChange={(e) =>
                setForm((s) => ({ ...s, assigneeId: e.target.value }))
              }
              className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="">未指派</option>
              {assignableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.isAI ? ' (AI)' : ''}
                </option>
              ))}
            </select>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <footer className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-muted-foreground hover:bg-surface-raised hover:text-foreground"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="new-task-submit"
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white shadow-sm transition-colors',
                'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {submitting ? '创建中...' : '创建'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
