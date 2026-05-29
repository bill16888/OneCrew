import { Activity, Bot, CheckCircle2, Clock, MessageSquare } from 'lucide-react';

import { AIBadge } from '@/components/ui/AIBadge';
import { cn } from '@/lib/utils';
import type {
  DashboardActivityItem,
  DashboardAIStatus,
  DashboardPendingApproval,
  DashboardPulse,
} from '@/lib/services/dashboard.service';

/**
 * @file Pure presentational panels for the operator dashboard
 * (Phase 1 Req 13.2). Each takes already-projected data and renders
 * markup only — no data fetching, no client state — so they can be
 * server-rendered on first paint and re-rendered from a refreshed
 * summary without special handling.
 */

function PanelShell({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <header className="flex items-center gap-2">
        <span aria-hidden className="text-muted-foreground">
          {icon}
        </span>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
      </header>
      {children}
    </section>
  );
}

export function TodayPulsePanel({ pulse }: { pulse: DashboardPulse }): JSX.Element {
  const stats: Array<{ label: string; value: number; sub?: string }> = [
    {
      label: '消息',
      value: pulse.messagesTotal,
      sub: `${pulse.messagesFromAI} 来自 AI`,
    },
    { label: '完成任务', value: pulse.tasksCompleted },
    { label: '已决审批', value: pulse.approvalsDecided },
  ];
  return (
    <PanelShell title="今日动态 (24h)" icon={<Activity className="h-4 w-4" />}>
      <div className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col gap-0.5">
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              {s.value}
            </span>
            <span className="text-xs text-muted-foreground">{s.label}</span>
            {s.sub ? (
              <span className="text-[11px] text-muted-foreground/70">{s.sub}</span>
            ) : null}
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

export function AIStatusPanel({ ai }: { ai: DashboardAIStatus[] }): JSX.Element {
  return (
    <PanelShell title="AI 状态" icon={<Bot className="h-4 w-4" />}>
      {ai.length === 0 ? (
        <p className="text-xs text-muted-foreground">尚无 AI 同事。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ai.map((a) => {
            const inactive = a.aiStatus !== 'active';
            return (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white',
                    inactive ? 'bg-surface-raised' : 'bg-ai-gradient',
                  )}
                >
                  {a.name.charAt(0).toUpperCase()}
                </span>
                <span className="truncate text-foreground/90">{a.name}</span>
                <AIBadge label="AI" />
                {a.isThinking ? (
                  <span className="ml-auto animate-ai-pulse text-[11px] italic text-ai-accent/80">
                    thinking…
                  </span>
                ) : (
                  <span
                    className={cn(
                      'ml-auto text-[11px]',
                      inactive ? 'text-muted-foreground/60' : 'text-emerald-400/80',
                    )}
                  >
                    {inactive ? '已停用' : '在线'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PanelShell>
  );
}

export function PendingApprovalsPanel({
  approvals,
}: {
  approvals: DashboardPendingApproval[];
}): JSX.Element {
  return (
    <PanelShell
      title={`待审批 (${approvals.length})`}
      icon={<Clock className="h-4 w-4" />}
    >
      {approvals.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400/80" aria-hidden />
          没有待处理的审批。
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {approvals.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-0.5 rounded-md border border-border/70 bg-surface-raised px-3 py-2"
            >
              <span className="text-sm text-foreground/90">{a.action}</span>
              <span className="text-[11px] text-muted-foreground">
                {a.aiName} · {new Date(a.createdAt).toLocaleString('zh-CN')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}

export function RecentActivityPanel({
  activity,
}: {
  activity: DashboardActivityItem[];
}): JSX.Element {
  const iconFor = (kind: DashboardActivityItem['kind']): React.ReactNode => {
    if (kind === 'message') return <MessageSquare className="h-3.5 w-3.5" />;
    if (kind === 'task') return <CheckCircle2 className="h-3.5 w-3.5" />;
    return <Clock className="h-3.5 w-3.5" />;
  };
  return (
    <PanelShell title="最近动态" icon={<Activity className="h-4 w-4" />}>
      {activity.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无动态。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {activity.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="flex items-start gap-2 text-xs">
              <span aria-hidden className="mt-0.5 text-muted-foreground/70">
                {iconFor(item.kind)}
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-foreground/85">{item.summary}</span>
                <span className="text-[10px] text-muted-foreground/60">
                  {new Date(item.at).toLocaleString('zh-CN')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}
