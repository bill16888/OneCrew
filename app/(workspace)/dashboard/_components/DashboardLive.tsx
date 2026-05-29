'use client';

import { useEffect, useState } from 'react';

import {
  getClientSocket,
} from '@/lib/realtime/client';
import { EVENTS } from '@/lib/realtime/events';
import type { DashboardSummary } from '@/lib/services/dashboard.service';

import {
  AIStatusPanel,
  PendingApprovalsPanel,
  RecentActivityPanel,
  TodayPulsePanel,
} from './panels';

/**
 * @file Client wrapper that renders the dashboard panels and keeps them
 * fresh (Phase 1 Req 13.3).
 *
 * Strategy: the server component passes the initial summary (rendered
 * on first paint). This client component then subscribes to the
 * workspace-wide realtime events that change dashboard data
 * (`message:new`, `task:updated`, `approval:created`, `ai:thinking`)
 * and, on any of them, re-fetches `/api/dashboard/summary` — debounced
 * so a burst of events triggers at most one refetch per second
 * (comfortably under the < 1s end-to-end ceiling for the user-visible
 * effect while avoiding a thundering-herd of fetches).
 *
 * We refetch the whole summary rather than patch individual panels
 * because the aggregation (counts, merged timeline) is cheap and
 * patching every derived field client-side would duplicate the
 * server's logic.
 */
export function DashboardLive({
  initial,
}: {
  initial: DashboardSummary;
}): JSX.Element {
  const [summary, setSummary] = useState<DashboardSummary>(initial);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function refetch(): Promise<void> {
      try {
        const res = await fetch('/api/dashboard/summary', {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = (await res.json()) as DashboardSummary;
        if (!cancelled) setSummary(data);
      } catch {
        // Best-effort refresh; keep the last good summary on failure.
      }
    }

    function scheduleRefetch(): void {
      if (timer) return; // debounce: one refetch per window
      timer = setTimeout(() => {
        timer = null;
        void refetch();
      }, 1000);
    }

    const socket = getClientSocket();
    socket.on(EVENTS.MessageNew, scheduleRefetch);
    socket.on(EVENTS.TaskUpdated, scheduleRefetch);
    socket.on(EVENTS.ApprovalCreated, scheduleRefetch);
    socket.on(EVENTS.AIThinking, scheduleRefetch);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      socket.off(EVENTS.MessageNew, scheduleRefetch);
      socket.off(EVENTS.TaskUpdated, scheduleRefetch);
      socket.off(EVENTS.ApprovalCreated, scheduleRefetch);
      socket.off(EVENTS.AIThinking, scheduleRefetch);
    };
  }, []);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <TodayPulsePanel pulse={summary.pulse} />
      <AIStatusPanel ai={summary.ai} />
      <PendingApprovalsPanel approvals={summary.pendingApprovals} />
      <RecentActivityPanel activity={summary.recentActivity} />
    </div>
  );
}
