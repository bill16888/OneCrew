'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Hash, ListChecks, Sparkles, X } from 'lucide-react';

import { TeammateManager } from '@/components/ai-teammates/TeammateManager';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

/**
 * Workspace sidebar: channel navigation, AI teammate management, and
 * the kanban board entry.
 */

export interface Channel {
  /** Stable id used as the dynamic route segment `/channels/[channelId]`. */
  id: string;
  /** Channel display name (without the leading `#`). */
  name: string;
}

const FALLBACK_CHANNELS: readonly Channel[] = [
  { id: 'chan_general', name: 'general' },
  { id: 'chan_engineering', name: 'engineering' },
];

export function Sidebar() {
  const pathname = usePathname();
  const currentChannelId = useWorkspaceStore((s) => s.currentChannelId);
  const setCurrentChannel = useWorkspaceStore((s) => s.setCurrentChannel);
  const isMobileSidebarOpen = useWorkspaceStore((s) => s.isMobileSidebarOpen);
  const closeMobileSidebar = useWorkspaceStore((s) => s.closeMobileSidebar);

  const [channels, setChannels] = useState<readonly Channel[]>(
    FALLBACK_CHANNELS,
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/channels', { credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<Channel[]>) : null))
      .then((data) => {
        if (!cancelled && data && data.length > 0) {
          setChannels(data);
        }
      })
      .catch(() => {
        // Fallback channels stay rendered.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isChannelActive = (id: string): boolean => {
    if (currentChannelId === id) return true;
    return pathname === `/channels/${id}`;
  };

  const isBoardActive = pathname?.startsWith('/board') ?? false;

  return (
    <>
      <div
        aria-hidden={!isMobileSidebarOpen}
        onClick={closeMobileSidebar}
        className={cn(
          'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity md:hidden',
          isMobileSidebarOpen
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none',
        )}
      />

      <aside
        aria-label="Workspace navigation"
        className={cn(
          'flex h-screen w-60 shrink-0 flex-col gap-4 border-r border-border bg-surface px-3 py-4',
          'fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out md:static md:translate-x-0',
          isMobileSidebarOpen
            ? 'translate-x-0'
            : '-translate-x-full md:translate-x-0',
        )}
      >
        <WorkspaceHeader onNavigate={closeMobileSidebar} />

        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeMobileSidebar}
          className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-raised hover:text-foreground md:hidden"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <nav className="flex flex-1 flex-col gap-6 overflow-y-auto">
          <SidebarSection title="频道">
            <ul className="flex flex-col gap-0.5">
              {channels.map((channel) => (
                <li key={channel.id}>
                  <Link
                    href={`/channels/${channel.id}`}
                    onClick={() => setCurrentChannel(channel.id)}
                    aria-current={
                      isChannelActive(channel.id) ? 'page' : undefined
                    }
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors',
                      'hover:bg-surface-raised hover:text-foreground',
                      isChannelActive(channel.id) &&
                        'bg-primary/15 text-primary-200',
                    )}
                  >
                    <Hash className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                    <span className="truncate">{channel.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </SidebarSection>

          <TeammateManager />

          <SidebarSection title="任务">
            <Link
              href="/board"
              onClick={closeMobileSidebar}
              aria-current={isBoardActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors',
                'hover:bg-surface-raised hover:text-foreground',
                isBoardActive && 'bg-primary/15 text-primary-200',
              )}
            >
              <ListChecks className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
              <span className="truncate">看板</span>
            </Link>
          </SidebarSection>
        </nav>
      </aside>
    </>
  );
}

function WorkspaceHeader({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-foreground hover:bg-surface-raised"
    >
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ai-gradient shadow-ai-glow"
      >
        <Sparkles className="h-4 w-4 text-white" />
      </span>
      <span className="truncate leading-tight">AI 协作工作区</span>
    </Link>
  );
}

interface SidebarSectionProps {
  title: string;
  children: React.ReactNode;
}

function SidebarSection({ title, children }: SidebarSectionProps) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </h2>
      {children}
    </section>
  );
}
