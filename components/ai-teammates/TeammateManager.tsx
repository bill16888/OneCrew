'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Bot,
  Check,
  Loader2,
  Pencil,
  Power,
  RotateCcw,
  UserPlus,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';

import { AIBadge } from '@/components/ui/AIBadge';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

interface AIColleague {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  aiRole: string | null;
  aiSettings: unknown;
  aiStatus: string | null;
}

interface AISettings {
  systemPrompt: string;
  toolSet: string[];
  mentionAliases: string[];
}

type DialogMode = 'create' | 'edit';

interface FormState {
  name: string;
  email: string;
  systemPrompt: string;
  toolSetText: string;
  mentionAliasesText: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  email: '',
  systemPrompt: '',
  toolSetText: '',
  mentionAliasesText: '',
};

const FALLBACK_TEAMMATES: readonly AIColleague[] = [];

function asRecord(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readAISettings(value: unknown): AISettings {
  const record = asRecord(value);
  return {
    systemPrompt:
      typeof record.systemPrompt === 'string' ? record.systemPrompt : '',
    toolSet: Array.isArray(record.toolSet)
      ? record.toolSet.filter((item): item is string => typeof item === 'string')
      : [],
    mentionAliases: Array.isArray(record.mentionAliases)
      ? record.mentionAliases.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toFormState(ai: AIColleague): FormState {
  const settings = readAISettings(ai.aiSettings);
  return {
    name: ai.name,
    email: ai.email,
    systemPrompt: settings.systemPrompt,
    toolSetText: settings.toolSet.join(', '),
    mentionAliasesText: settings.mentionAliases.join(', '),
  };
}

function roleLabel(ai: AIColleague): string {
  const status = ai.aiStatus ?? 'active';
  if (status !== 'active') return '已停用';
  return ai.aiRole ?? '自定义';
}

export function TeammateManager(): JSX.Element {
  const thinkingAIs = useWorkspaceStore((s) => s.thinkingAIs);

  const [teammates, setTeammates] = useState<readonly AIColleague[]>(
    FALLBACK_TEAMMATES,
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>('create');
  const [editing, setEditing] = useState<AIColleague | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [open, setOpen] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const sortedTeammates = useMemo(
    () =>
      [...teammates].sort((a, b) => {
        const statusA = a.aiStatus ?? 'active';
        const statusB = b.aiStatus ?? 'active';
        if (statusA !== statusB) return statusA === 'active' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [teammates],
  );

  async function loadTeammates(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/ai-colleagues', {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as AIColleague[];
      setTeammates(data.length > 0 ? data : []);
    } catch {
      setError('加载 AI 同事列表失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTeammates();
  }, []);

  function openCreateDialog(): void {
    setDialogMode('create');
    setEditing(null);
    setForm(EMPTY_FORM);
    setError(null);
    setOpen(true);
  }

  function openEditDialog(ai: AIColleague): void {
    setDialogMode('edit');
    setEditing(ai);
    setForm(toFormState(ai));
    setError(null);
    setOpen(true);
  }

  function updateForm<K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitForm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const toolSet = parseList(form.toolSetText);
    const mentionAliases = parseList(form.mentionAliasesText);
    const payload =
      dialogMode === 'create'
        ? {
            name: form.name,
            email: form.email,
            systemPrompt: form.systemPrompt,
            toolSet,
            mentionAliases,
          }
        : {
            name: form.name,
            systemPrompt: form.systemPrompt,
            toolSet,
            mentionAliases,
          };

    const endpoint =
      dialogMode === 'create'
        ? '/api/ai-colleagues'
        : `/api/ai-colleagues/${editing?.id ?? ''}`;

    try {
      const response = await fetch(endpoint, {
        method: dialogMode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: unknown }
          | null;
        throw new Error(
          typeof body?.error === 'string'
            ? body.error
            : `HTTP ${response.status}`,
        );
      }
      const saved = (await response.json()) as AIColleague;
      setTeammates((prev) => {
        if (dialogMode === 'create') return [...prev, saved];
        return prev.map((ai) => (ai.id === saved.id ? saved : ai));
      });
      setOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save AI.');
    } finally {
      setSubmitting(false);
    }
  }

  async function setAIStatus(ai: AIColleague, status: 'active' | 'inactive') {
    if (mutatingId !== null) return;
    setMutatingId(ai.id);
    setError(null);
    try {
      const response =
        status === 'inactive'
          ? await fetch(`/api/ai-colleagues/${ai.id}`, {
              method: 'DELETE',
              credentials: 'same-origin',
            })
          : await fetch(`/api/ai-colleagues/${ai.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ aiStatus: 'active' }),
            });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const saved = (await response.json()) as AIColleague;
      setTeammates((prev) =>
        prev.map((item) => (item.id === saved.id ? saved : item)),
      );
    } catch {
      setError('Failed to update AI status.');
    } finally {
      setMutatingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          AI 同事
        </span>
        <button
          type="button"
          onClick={openCreateDialog}
          title="创建 AI 同事"
          aria-label="创建 AI 同事"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <UserPlus className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <ul className="flex flex-col gap-0.5">
        {sortedTeammates.map((ai) => {
          const isInactive = (ai.aiStatus ?? 'active') !== 'active';
          const isThinking = thinkingAIs.has(ai.id);
          const isMutating = mutatingId === ai.id;
          return (
            <li
              key={ai.id}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground',
                isInactive && 'opacity-55',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white',
                  isInactive ? 'bg-surface-raised' : 'bg-ai-gradient',
                )}
              >
                {ai.name.charAt(0).toUpperCase()}
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-foreground/90">{ai.name}</span>
                  {isThinking ? (
                    <Loader2
                      className="h-3 w-3 shrink-0 animate-spin text-ai-accent"
                      aria-hidden
                    />
                  ) : null}
                </span>
                {isThinking ? (
                  <span
                    role="status"
                    aria-live="polite"
                    className="truncate text-[11px] italic text-ai-accent/80 animate-ai-pulse"
                  >
                    thinking...
                  </span>
                ) : (
                  <span className="truncate text-[11px] text-muted-foreground/80">
                    {roleLabel(ai)}
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  onClick={() => openEditDialog(ai)}
                  title="编辑"
                  aria-label={`编辑 ${ai.name}`}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-raised hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  disabled={isMutating}
                  onClick={() =>
                    void setAIStatus(ai, isInactive ? 'active' : 'inactive')
                  }
                  title={isInactive ? '启用' : '停用'}
                  aria-label={`${isInactive ? '启用' : '停用'} ${ai.name}`}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isMutating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : isInactive ? (
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Power className="h-3.5 w-3.5" aria-hidden />
                  )}
                </button>
              </div>
              <AIBadge label="AI" />
            </li>
          );
        })}
      </ul>

      {loading ? (
        <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Loading
        </div>
      ) : null}

      {error !== null ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-lg border border-border bg-surface-overlay p-6 text-foreground shadow-2xl focus:outline-none">
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ai-gradient text-white"
              >
                <Bot className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="text-base font-semibold">
                  {dialogMode === 'create'
                    ? '创建 AI 同事'
                    : '编辑 AI 同事'}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="sr-only">
                  Manage AI teammate settings.
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                disabled={submitting}
                className="rounded-md p-1 text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-4 w-4" aria-hidden />
              </DialogPrimitive.Close>
            </div>

            <form onSubmit={submitForm} className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  名称
                  <input
                    value={form.name}
                    onChange={(event) => updateForm('name', event.target.value)}
                    required
                    className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  邮箱
                  <input
                    type="email"
                    value={form.email}
                    onChange={(event) => updateForm('email', event.target.value)}
                    required
                    disabled={dialogMode === 'edit'}
                    className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                系统提示词
                <textarea
                  value={form.systemPrompt}
                  onChange={(event) =>
                    updateForm('systemPrompt', event.target.value)
                  }
                  rows={7}
                  className="min-h-40 resize-y rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Tool set
                <input
                  value={form.toolSetText}
                  onChange={(event) =>
                    updateForm('toolSetText', event.target.value)
                  }
                  placeholder="mock_web_search, create_task"
                  className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
                />
                <span className="text-[10px] font-normal text-muted-foreground/70">
                  留空则允许使用全部工具；填入名称（逗号分隔）后将仅允许这些工具。
                </span>
              </label>

              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                @ 别名
                <input
                  value={form.mentionAliasesText}
                  onChange={(event) =>
                    updateForm('mentionAliasesText', event.target.value)
                  }
                  placeholder="小林, lin, 林"
                  className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
                />
                <span className="text-[10px] font-normal text-muted-foreground/70">
                  额外可触发该 AI 的 @ 提及别名（逗号分隔，大小写不敏感）。
                </span>
              </label>

              {error !== null ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {error}
                </div>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <DialogPrimitive.Close asChild>
                  <button
                    type="button"
                    disabled={submitting}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X className="h-4 w-4" aria-hidden />
                    取消
                  </button>
                </DialogPrimitive.Close>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Check className="h-4 w-4" aria-hidden />
                  )}
                  保存
                </button>
              </div>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
