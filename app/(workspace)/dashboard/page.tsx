import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth/options';
import { DashboardService } from '@/lib/services/dashboard.service';

import { DashboardLive } from './_components/DashboardLive';

/**
 * `/dashboard` — operator command center (Phase 1 Req 13).
 *
 * Server component: auth-gates, computes the consolidated summary once
 * for the first paint, then hands it to the {@link DashboardLive}
 * client wrapper which keeps the panels fresh from realtime events.
 *
 * The four panels (today's pulse, AI status, pending approvals, recent
 * activity) stack on one column below the `lg` breakpoint and form a
 * 2×2 grid above it.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<JSX.Element> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect('/login');
  }

  const summary = await DashboardService.getDashboardSummary();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          指挥中心
        </h1>
        <p className="text-sm text-muted-foreground">
          今天的工作区概览 — AI 在做什么、有什么等你决策。
        </p>
      </header>
      <DashboardLive initial={summary} />
    </div>
  );
}
