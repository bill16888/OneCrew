'use client';

import { useEffect, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * @file Collapsible channel knowledge card (Req 19.10, 19.11).
 *
 * Renders at the top of a channel. Collapsed by default; the header
 * shows a one-line summary (first non-empty line of the card, or a
 * "add knowledge" prompt when empty). Expanding reveals a Markdown
 * textarea the operator can edit and save via
 * `PUT /api/channels/[id]/knowledge`.
 *
 * The card fetches its own initial content on mount (GET) so the parent
 * `ChannelView` doesn't need to thread it through. Read-only display
 * uses plain pre-wrap text for the MVP (no Markdown renderer dep).
 */

const MAX_LENGTH = 8000;

export function ChannelKnowledgeCard({
  channelId,
}: {
  channelId: string;
}): JSX.Element {
  const [content, setContent] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [expanded, setExpanded] = useState<boolean>(false);
  const [editing, setEditing] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpanded(false);
    setEditing(false);
    void (async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/knowledge`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { content: string | null };
        if (!cancelled) setContent(data.content ?? '');
      } catch {
        if (!cancelled) setError('加载频道知识失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  function startEdit(): void {
    setDraft(content);
    setEditing(true);
    setExpanded(true);
    setError(null);
  }

  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${channelId}/knowledge`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content: draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: unknown }
          | null;
        throw new Error(
          typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as { content: string | null };
      setContent(data.content ?? '');
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const summary =
    content.split('\n').find((l) => l.trim().length > 0)?.trim() ??
    '添加频道知识，让 AI 更懂这个项目';
  const hasCard = content.trim().length > 0;

  return (
    <section className="border-b border-border bg-surface/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground hover:bg-surface-raised"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
        <span className="truncate">
          {loading ? '加载频道知识…' : summary}
        </span>
      </button>

      {expanded && !loading ? (
        <div className="px-4 pb-3">
          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, MAX_LENGTH))}
                rows={10}
                placeholder={
                  '## 项目信息\n- 仓库: github.com/...\n- 数据库: PostgreSQL 16\n\n## 当前 Sprint\n- ...\n\n## 团队\n- 后端: @Ada'
                }
                className="min-h-48 resize-y rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground/70">
                  {draft.length} / {MAX_LENGTH}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                    className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-surface-raised disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary-600 disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : null}
                    保存
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <pre
                className={cn(
                  'whitespace-pre-wrap break-words rounded-md bg-surface-raised px-3 py-2 text-xs',
                  hasCard ? 'text-foreground/85' : 'text-muted-foreground italic',
                )}
              >
                {hasCard ? content : '还没有频道知识。点击「编辑」添加。'}
              </pre>
              <button
                type="button"
                onClick={startEdit}
                className="self-start rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-surface-raised"
              >
                编辑
              </button>
            </div>
          )}
          {error !== null ? (
            <p role="alert" className="mt-2 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
