'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  Check,
  Clock,
  FileText,
  GitBranch,
  Layers,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { AIBadge } from '@/components/ui/AIBadge';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

/**
 * ApprovalDialog — modal a human uses to approve or reject a high-risk
 * action that an AI colleague has surfaced via the `request_approval`
 * tool (Requirements 6.1, 6.3, 6.4). The dialog highlights background,
 * impact scope, risk level, and alternatives before exposing the raw
 * action payload.
 *
 * Wired in task 9.5:
 *   - Approve / Reject submit a `PATCH /api/approvals/[id]` request with
 *     `{ decision: 'approve' | 'reject' }`. The route handler performs
 *     the `PENDING → APPROVED` / `PENDING → REJECTED` transition and
 *     emits the matching event on the {@link agenticEmitter} so the
 *     Agentic Loop can react without the dialog touching the realtime
 *     layer directly.
 *   - {@link ApprovalDialogProps.isStale} — when `true`, a prominent
 *     destructive-tinted banner is rendered above the action so users
 *     can spot approvals that have been waiting longer than 24 h
 *     (Requirement 6.7).
 *   - The store-driven open state (Requirement 9.6) keeps multiple
 *     mounted dialogs in sync: only the instance whose
 *     {@link ApprovalDialogProps.approvalId} matches
 *     `useWorkspaceStore.approvalDialog.approvalId` becomes visible.
 *
 * Validates: Requirements 6.1, 6.3, 6.4, 6.7.
 */

/**
 * Decision wire literal. Kept as a discriminated string so callers,
 * the route handler, and the on-resolved callback all share the same
 * narrow union.
 */
export type ApprovalDecision = 'approve' | 'reject';

type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

interface ApprovalAnalysis {
  background: string;
  impactScope: string;
  riskLevel: ApprovalRiskLevel;
  alternatives: string[];
}

const RISK_META: Record<
  ApprovalRiskLevel,
  { label: string; className: string; iconClassName: string }
> = {
  low: {
    label: '低风险',
    className: 'border-success/40 bg-success/10 text-success',
    iconClassName: 'text-success',
  },
  medium: {
    label: '中风险',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    iconClassName: 'text-amber-300',
  },
  high: {
    label: '高风险',
    className: 'border-orange-500/45 bg-orange-500/10 text-orange-300',
    iconClassName: 'text-orange-300',
  },
  critical: {
    label: '严重风险',
    className: 'border-destructive/50 bg-destructive/10 text-destructive',
    iconClassName: 'text-destructive',
  },
  unknown: {
    label: '未标注风险',
    className: 'border-border bg-surface-raised text-muted-foreground',
    iconClassName: 'text-muted-foreground',
  },
};

/**
 * Props for a single approval row. Once realtime is wired up via the
 * surrounding {@link ApprovalCenter}, these are derived from the
 * `approval:created` payload plus a workspace-level AI user directory.
 */
export interface ApprovalDialogProps {
  /** Approval row id — also used to match the open dialog in the store. */
  approvalId: string;
  /** Display name of the AI colleague that requested the approval. */
  aiUserName: string;
  /**
   * Tool action being gated, e.g. `"create_task"` or
   * `"send_channel_message"`. Rendered prominently as the headline.
   */
  action: string;
  /**
   * Free-form structured payload the AI submitted alongside the request.
   * Rendered inside a collapsible `<details>` block (read-only JSON).
   */
  payload?: unknown;
  /** Optional natural-language rationale supplied by the AI. */
  reason?: string;
  /** Wall-clock time the approval was created (used for relative time). */
  createdAt: Date | string;
  /**
   * Mark the approval as stale (older than 24 h). When true, a
   * destructive-tinted banner is rendered at the top of the dialog and
   * the dialog frame switches to a red border, satisfying Requirement
   * 6.7 ("UI 上显著标注").
   */
  isStale?: boolean;
  /**
   * Invoked **after** the PATCH commit succeeds. Parents typically use
   * this to remove the approval from their pending list. The dialog
   * itself takes care of closing the store-driven open state.
   */
  onResolved?: (approvalId: string, decision: ApprovalDecision) => void;
}

export function ApprovalDialog({
  approvalId,
  aiUserName,
  action,
  payload,
  reason,
  createdAt,
  isStale = false,
  onResolved,
}: ApprovalDialogProps): JSX.Element {
  // Subscribe with a selector so unrelated store changes (e.g. the
  // active channel id) do not re-render this dialog.
  const isOpen = useWorkspaceStore(
    (s) => s.approvalDialog.open && s.approvalDialog.approvalId === approvalId,
  );
  const closeApproval = useWorkspaceStore((s) => s.closeApproval);

  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createdDate =
    typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  const payloadRecord = asRecord(payload);
  const displayReason = firstNonBlank(
    reason,
    getStringField(payloadRecord, 'reason'),
  );
  const analysis = resolveApprovalAnalysis({
    action,
    payload: payloadRecord,
    reason: displayReason,
  });
  const actionPayload = stripApprovalMetadata(payloadRecord);
  const payloadJson =
    actionPayload === null
      ? null
      : safeStringify(actionPayload);

  /**
   * Issue the PATCH request and dispatch the resolved callback /
   * close the dialog when the route handler reports success. Errors
   * are surfaced inline so the user can retry without losing context;
   * the dialog stays open with the previously typed decision intent.
   */
  const submitDecision = async (decision: ApprovalDecision): Promise<void> => {
    if (submitting !== null) return;
    setSubmitting(decision);
    setError(null);

    let response: Response;
    try {
      response = await fetch(`/api/approvals/${approvalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ decision }),
      });
    } catch {
      setError('Network error while submitting decision.');
      setSubmitting(null);
      return;
    }

    if (!response.ok) {
      let message = `Failed to update approval (HTTP ${response.status}).`;
      try {
        const body: unknown = await response.json();
        if (
          body !== null &&
          typeof body === 'object' &&
          'error' in body &&
          typeof (body as { error: unknown }).error === 'string'
        ) {
          message = (body as { error: string }).error;
        }
      } catch {
        // Non-JSON error body — keep the default HTTP-status message.
      }
      setError(message);
      setSubmitting(null);
      return;
    }

    // Persisted; let the parent remove this row from its pending list,
    // then close the store-driven open state. Order matters: closing
    // first would cause `isOpen` to flip to `false` and re-render the
    // dialog tree before the parent state update lands.
    onResolved?.(approvalId, decision);
    setSubmitting(null);
    closeApproval();
  };

  const handleApprove = (): void => {
    void submitDecision('approve');
  };
  const handleReject = (): void => {
    void submitDecision('reject');
  };

  /**
   * Bridge Radix's `onOpenChange` (escape / outside click) into the
   * Zustand store. We refuse to close while a PATCH is in flight so
   * the user cannot accidentally dismiss a half-completed decision.
   */
  const handleOpenChange = (next: boolean): void => {
    if (next) return;
    if (submitting !== null) return;
    closeApproval();
  };

  // Stale approvals get a destructive (red) frame; otherwise the
  // standard amber warning treatment is preserved.
  const frameBorderClass = isStale
    ? 'border-destructive/70 shadow-destructive/20'
    : 'border-amber-500/50 shadow-amber-500/10';

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            // Layout
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-2xl',
            '-translate-x-1/2 -translate-y-1/2',
            // Surface + warning border (Requirement 6 visual cue)
            'rounded-lg border-2 bg-surface-overlay text-foreground',
            'shadow-2xl',
            frameBorderClass,
            'max-h-[calc(100vh-2rem)] overflow-y-auto p-6',
            // Animation
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            // Focus ring fallback for the dialog itself
            'focus:outline-none',
          )}
        >
          {/* Stale banner — Requirement 6.7 */}
          {isStale && (
            <div
              role="alert"
              data-testid="approval-stale-banner"
              className={cn(
                'mb-4 flex items-center gap-2 rounded-md border border-destructive/50',
                'bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive',
              )}
            >
              <Clock className="h-4 w-4 shrink-0" aria-hidden />
              <span>Pending &gt; 24h; please decide promptly</span>
            </div>
          )}

          {/* Header */}
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                isStale
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-amber-500/15 text-amber-400',
              )}
            >
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div className="flex flex-1 flex-col gap-1.5">
              <DialogPrimitive.Title className="text-base font-semibold leading-tight text-foreground">
                Approval requested
              </DialogPrimitive.Title>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <AIBadge label="AI" />
                <span className="font-medium text-foreground/90">
                  {aiUserName}
                </span>
                <span aria-hidden className="opacity-50">
                  ·
                </span>
                <time
                  dateTime={createdDate.toISOString()}
                  title={createdDate.toISOString()}
                >
                  {formatDistanceToNow(createdDate, { addSuffix: true })}
                </time>
              </div>
            </div>
            <DialogPrimitive.Close
              aria-label="Dismiss"
              disabled={submitting !== null}
              className={cn(
                'rounded-md p-1 text-muted-foreground transition-colors',
                'hover:bg-surface-raised hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>

          {/* Action summary */}
          <section className="mt-6 rounded-md border border-border bg-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <span className="text-[11px] font-semibold uppercase text-muted-foreground/80">
                 请求的操作
                </span>
                <code className="mt-1 block break-words font-mono text-lg font-semibold text-foreground">
                  {action}
                </code>
              </div>
              <RiskBadge riskLevel={analysis.riskLevel} />
            </div>
            <DialogPrimitive.Description className="sr-only">
              {analysis.background}
            </DialogPrimitive.Description>
          </section>

          {/* Structured approval analysis */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <AnalysisPanel icon={FileText} title="背景">
              {analysis.background}
            </AnalysisPanel>
            <AnalysisPanel icon={Layers} title="影响范围">
              {analysis.impactScope}
            </AnalysisPanel>
            <AnalysisPanel
              icon={ShieldAlert}
              title="风险等级"
              iconClassName={RISK_META[analysis.riskLevel].iconClassName}
            >
              <span className="font-medium text-foreground">
                {RISK_META[analysis.riskLevel].label}
              </span>
            </AnalysisPanel>
            <AnalysisPanel icon={GitBranch} title="替代方案">
              <ul className="space-y-1.5">
                {analysis.alternatives.map((alternative, index) => (
                  <li key={`${index}-${alternative}`} className="flex gap-2">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" />
                    <span>{alternative}</span>
                  </li>
                ))}
              </ul>
            </AnalysisPanel>
          </div>

          {/* Optional structured payload — collapsed by default */}
          {payloadJson ? (
            <details className="mt-4 rounded-md border border-border bg-surface">
              <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold uppercase text-muted-foreground/80">
                Action payload
              </summary>
              <pre className="max-h-56 overflow-auto rounded-b-md bg-surface px-3 pb-3 pt-0 text-xs leading-relaxed text-muted-foreground">
                {payloadJson}
              </pre>
            </details>
          ) : null}

          {/* Inline error feedback from a failed PATCH */}
          {error !== null && (
            <div
              role="alert"
              className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}

          {/* Actions — large hit targets */}
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={handleReject}
              disabled={submitting !== null}
              data-testid="approval-reject"
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-md px-6 py-3 text-sm font-medium',
                'border border-border bg-surface text-foreground transition-colors',
                'hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <X className="h-4 w-4" aria-hidden />
              {submitting === 'reject' ? '拒绝中…' : '拒绝'}
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={submitting !== null}
              data-testid="approval-approve"
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-md px-6 py-3 text-sm font-semibold',
                'bg-primary text-primary-foreground transition-colors',
                'hover:bg-primary-600',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <Check className="h-4 w-4" aria-hidden />
              {submitting === 'approve' ? '批准中…' : '批准'}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function RiskBadge({
  riskLevel,
}: {
  riskLevel: ApprovalRiskLevel;
}): JSX.Element {
  const meta = RISK_META[riskLevel];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold',
        meta.className,
      )}
    >
      <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

function AnalysisPanel({
  icon: Icon,
  title,
  children,
  iconClassName,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  iconClassName?: string;
}): JSX.Element {
  return (
    <section className="rounded-md border border-border bg-surface px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Icon
          className={cn('h-4 w-4 shrink-0 text-primary-300', iconClassName)}
          aria-hidden
        />
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      </div>
      <div className="text-sm leading-6 text-muted-foreground">{children}</div>
    </section>
  );
}

/**
 * `JSON.stringify` that swallows cyclic-reference errors. Approval
 * payloads are produced by AI tool calls and validated by Zod, so they
 * should already be plain JSON, but defensive serialization keeps the
 * dialog from ever crashing the workspace shell.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return null;
}

function getStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function firstNonBlank(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function getAlternatives(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 5);
}

function normalizeRiskLevel(value: unknown): ApprovalRiskLevel {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'critical'
  ) {
    return normalized;
  }
  if (normalized === '低') return 'low';
  if (normalized === '中') return 'medium';
  if (normalized === '高') return 'high';
  if (normalized === '严重') return 'critical';
  return 'unknown';
}

function summarizePayloadImpact(
  action: string,
  payload: Record<string, unknown> | null,
): string {
  const keys = Object.keys(payload ?? {}).filter(
    (key) => key !== 'reason' && key !== 'approvalAnalysis',
  );
  if (keys.length === 0) {
    return `将执行 ${action}，未提供额外参数。`;
  }
  return `将执行 ${action}，影响参数：${keys.slice(0, 8).join('、')}。`;
}

function resolveApprovalAnalysis({
  action,
  payload,
  reason,
}: {
  action: string;
  payload: Record<string, unknown> | null;
  reason?: string;
}): ApprovalAnalysis {
  const analysisRecord = asRecord(payload?.approvalAnalysis);
  const alternatives = getAlternatives(analysisRecord?.alternatives);

  return {
    background:
      firstNonBlank(getStringField(analysisRecord, 'background'), reason) ??
      `需要人工确认 ${action} 是否应该继续执行。`,
    impactScope:
      firstNonBlank(getStringField(analysisRecord, 'impactScope')) ??
      summarizePayloadImpact(action, payload),
    riskLevel: normalizeRiskLevel(analysisRecord?.riskLevel),
    alternatives:
      alternatives.length > 0
        ? alternatives
        : [
            '暂缓执行，等待负责人补充上下文。',
            '先拆成可回滚的小步骤，再评估是否继续。',
          ],
  };
}

function stripApprovalMetadata(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (payload === null) return null;
  const entries = Object.entries(payload).filter(
    ([key]) => key !== 'reason' && key !== 'approvalAnalysis',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
