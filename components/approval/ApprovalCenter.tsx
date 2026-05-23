'use client';

import { useEffect, useState } from 'react';

import {
  ApprovalDialog,
  type ApprovalDecision,
} from '@/components/approval/ApprovalDialog';
import { getClientSocket } from '@/lib/realtime/client';
import {
  EVENTS,
  type ApprovalCreatedPayload,
} from '@/lib/realtime/events';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

/**
 * ApprovalCenter — workspace-level watcher that subscribes to the
 * `approval:created` realtime event and orchestrates the approval
 * review flow (Requirements 6.1, 6.3, 6.4, 6.7).
 *
 * Responsibilities:
 *   1. Subscribe to {@link EVENTS.ApprovalCreated} via the singleton
 *      browser-side Socket.io client and append every distinct payload
 *      to a local `pending` list. The newest approval is automatically
 *      surfaced via `useWorkspaceStore.openApproval` so reviewers see
 *      it immediately (Requirement 6.1).
 *   2. Re-hydrate the `pending` list from a server-prefetched seed
 *      ({@link ApprovalCenterProps.initialPending}) so a hard refresh
 *      does not lose existing PENDING approvals — important for stale
 *      ones that, by definition, were created more than 24 h ago and
 *      thus arrive *before* the current Socket.io connection.
 *   3. Compute `isStale` (more than 24 h since `createdAt`) on the
 *      client and pass it into each {@link ApprovalDialog}. The value
 *      is recomputed on a 60 s tick so a long-lived tab eventually
 *      flips approvals as they cross the threshold (Requirement 6.7).
 *   4. After the dialog reports a successful PATCH via `onResolved`,
 *      remove the row from `pending` and surface the next one (if
 *      any) so the reviewer sweeps the queue without re-clicking.
 *
 * The center mounts once near the workspace shell (see
 * `app/(workspace)/layout.tsx`) and renders one
 * {@link ApprovalDialog} per pending approval. Only the dialog whose
 * id matches `useWorkspaceStore.approvalDialog.approvalId` is visible
 * at a time — the others stay mounted but invisible until promoted.
 *
 * Validates: Requirements 6.1, 6.3, 6.4, 6.7.
 */

/** 24 h in milliseconds — the staleness threshold (Requirement 6.7). */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** Refresh `now` every minute so stale flips happen during long sessions. */
const STALE_TICK_MS = 60 * 1000;

/**
 * Read-only directory of AI display names keyed by `User.id`. The
 * realtime payload only carries `aiUserId`, so this map is supplied by
 * the layout (which has database access) to render friendly names.
 * Senders missing from the map fall back to the raw id.
 */
export type AIUserDirectory = Readonly<
  Record<string, { name: string }>
>;

export interface ApprovalCenterProps {
  /** AI user id → display name map for header rendering. */
  aiDirectory?: AIUserDirectory;
  /**
   * Server-prefetched PENDING approvals. The shape mirrors the
   * realtime `approval:created` payload so initial-load and live
   * updates are interchangeable downstream.
   */
  initialPending?: readonly ApprovalCreatedPayload[];
}

/**
 * Pure helper: an approval is stale once `now - createdAt` exceeds
 * 24 h. Strict `>` matches the service-layer
 * {@link ApprovalService.isStale} predicate so client and server agree
 * on the boundary.
 */
function isPayloadStale(createdAt: string, nowMs: number): boolean {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return false;
  return nowMs - createdMs > STALE_THRESHOLD_MS;
}

export function ApprovalCenter({
  aiDirectory = {},
  initialPending = [],
}: ApprovalCenterProps): JSX.Element {
  const [pending, setPending] = useState<readonly ApprovalCreatedPayload[]>(
    () => initialPending,
  );
  // Tick-driven `now` so isStale recomputes during long sessions.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const openApproval = useWorkspaceStore((s) => s.openApproval);
  const closeApproval = useWorkspaceStore((s) => s.closeApproval);
  const dialogOpen = useWorkspaceStore((s) => s.approvalDialog.open);
  const dialogApprovalId = useWorkspaceStore(
    (s) => s.approvalDialog.approvalId,
  );

  // Re-seed `pending` if the parent hands us a different prefetch
  // snapshot (e.g. a soft navigation that re-renders the layout).
  useEffect(() => {
    setPending(initialPending);
  }, [initialPending]);

  // 1. Subscribe to `approval:created` and surface each new payload.
  useEffect(() => {
    const socket = getClientSocket();
    const handleApprovalCreated = (
      payload: ApprovalCreatedPayload,
    ): void => {
      setPending((prev) => {
        // Idempotency: ignore duplicate deliveries during reconnects so
        // the dialog list does not double up.
        if (prev.some((p) => p.id === payload.id)) return prev;
        return [...prev, payload];
      });
      // Promote the newest approval so the user sees it right away.
      // The watcher effect below will sort out conflicts if multiple
      // arrive in the same tick.
      openApproval(payload.id);
    };

    socket.on(EVENTS.ApprovalCreated, handleApprovalCreated);
    return () => {
      socket.off(EVENTS.ApprovalCreated, handleApprovalCreated);
    };
  }, [openApproval]);

  // 2. Tick `now` for the stale calculation.
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, STALE_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, []);

  // 3. Keep the store's "open dialog" pointer aligned with the
  //    `pending` list:
  //      - if the targeted approval is gone (resolved elsewhere),
  //        promote the oldest remaining one;
  //      - if nothing is left, close the dialog;
  //      - if there are pending entries but none is open, open the
  //        oldest so the reviewer is always nudged to decide.
  useEffect(() => {
    if (pending.length === 0) {
      if (dialogOpen) closeApproval();
      return;
    }
    const stillValid =
      dialogApprovalId !== null &&
      pending.some((p) => p.id === dialogApprovalId);
    if (stillValid) return;
    openApproval(pending[0].id);
  }, [pending, dialogOpen, dialogApprovalId, openApproval, closeApproval]);

  // 4. Removal handler invoked by ApprovalDialog after a successful PATCH.
  const handleResolved = (
    approvalId: string,
    _decision: ApprovalDecision,
  ): void => {
    setPending((prev) => prev.filter((p) => p.id !== approvalId));
  };

  return (
    <>
      {pending.map((approval) => (
        <ApprovalDialog
          key={approval.id}
          approvalId={approval.id}
          aiUserName={
            aiDirectory[approval.aiUserId]?.name ?? approval.aiUserId
          }
          action={approval.action}
          payload={approval.payload ?? undefined}
          createdAt={approval.createdAt}
          isStale={isPayloadStale(approval.createdAt, nowMs)}
          onResolved={handleResolved}
        />
      ))}
    </>
  );
}
