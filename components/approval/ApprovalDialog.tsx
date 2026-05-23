'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Check, Clock, X } from 'lucide-react';
import { useState } from 'react';

import { AIBadge } from '@/components/ui/AIBadge';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

/**
 * ApprovalDialog — modal a human uses to approve or reject a high-risk
 * action that an AI colleague has surfaced via the `request_approval`
 * tool (Requirements 6.1, 6.3, 6.4).
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
  const payloadJson =
    payload === undefined || payload === null
      ? null
      : safeStringify(payload);

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
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg',
            '-translate-x-1/2 -translate-y-1/2',
            // Surface + warning border (Requirement 6 visual cue)
            'rounded-lg border-2 bg-surface-overlay text-foreground',
            'shadow-2xl',
            frameBorderClass,
            'p-6',
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
              <span>⚠️ Pending &gt; 24h — please decide promptly</span>
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

          {/* Action description — centered, clear */}
          <div className="mt-6 flex flex-col items-center gap-1 text-center">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              Action
            </span>
            <code className="font-mono text-lg font-semibold text-foreground">
              {action}
            </code>
          </div>

          {/* Optional rationale — also doubles as the dialog description */}
          {reason ? (
            <DialogPrimitive.Description className="mt-4 rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted-foreground">
              {reason}
            </DialogPrimitive.Description>
          ) : (
            // Provide a hidden description so screen readers always have
            // something to announce alongside the dialog title.
            <DialogPrimitive.Description className="sr-only">
              {`AI colleague ${aiUserName} requested approval for ${action}.`}
            </DialogPrimitive.Description>
          )}

          {/* Optional structured payload — collapsed by default */}
          {payloadJson ? (
            <details className="mt-4 rounded-md border border-border bg-surface">
              <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                Payload
              </summary>
              <pre className="overflow-auto rounded-b-md bg-surface px-3 pb-3 pt-0 text-xs leading-relaxed text-muted-foreground">
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
              {submitting === 'reject' ? 'Rejecting…' : 'Reject'}
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
              {submitting === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
