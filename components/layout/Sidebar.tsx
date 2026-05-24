'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Hash, ListChecks, Loader2, Sparkles, X } from 'lucide-react';
import { AIBadge } from '@/components/ui/AIBadge';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

/**
 * Workspace sidebar — channels list, AI teammates, and the kanban board entry.
 *
 * Static skeleton from task 2.3:
 *   - hard-codes the channel and AI teammate lists (mock data; the real
 *     ChannelService is wired up in tasks 3.4 / 3.6),
 *   - performs no API calls,
 *   - relies on `useWorkspaceStore.currentChannelId` to highlight the
 *     active channel (Requirement 9.6 — shared client state goes through
 *     Zustand).
 *
 * Active highlighting strategy:
 *   - We treat the route as the source of truth and mirror it into the
 *     store on click. That way a hard refresh on `/channels/general`
 *     still highlights `general` even before any client effect runs.
 *
 * Visual: 240px (`w-60`) wide column, dark surface (#111113), Indigo
 * accent for the active row (Requirements 9.1, 9.2, 9.5).
 */

/**
 * Sidebar-level Channel summary.
 *
 * Mirrors the eventual `/api/channels` response shape (task 3.6) so the
 * sidebar can swap mock data for real data with a single import change.
 * Keep this minimal: only the fields the sidebar actually reads.
 */
export interface Channel {
  /** Stable id used as the dynamic route segment `/channels/[channelId]`. */
  id: string;
  /** Channel display name (without the leading `#`). */
  name: string;
}

interface AITeammate {
  id: string;
  name: string;
  /** Role label echoed in the sidebar (e.g. "Product", "Engineering"). */
  role: string;
}

/**
 * Hard-coded fallback channel list shown only on the very first
 * client paint (before `/api/channels` resolves). The IDs match the
 * seeded rows in `prisma/seed.ts` so the fallback never produces
 * dead links if the fetch races with first-render hydration.
 */
const FALLBACK_CHANNELS: readonly Channel[] = [
  { id: 'chan_general', name: 'general' },
  { id: 'chan_engineering', name: 'engineering' },
];

const MOCK_AI_TEAMMATES: readonly AITeammate[] = [
  { id: 'user_ai_ada', name: 'Ada', role: 'Product' },
  { id: 'user_ai_hopper', name: 'Hopper', role: 'Engineering' },
];

export function Sidebar() {
  const pathname = usePathname();
  const currentChannelId = useWorkspaceStore((s) => s.currentChannelId);
  const setCurrentChannel = useWorkspaceStore((s) => s.setCurrentChannel);
  // Driven by `<TeammateThinking />` subscribing to the `ai:thinking`
  // socket event. We read the whole set so that adding / removing any
  // AI re-renders the teammate list (Requirements 7.6, 7.7).
  const thinkingAIs = useWorkspaceStore((s) => s.thinkingAIs);

  // Mobile drawer state (P2 task #5). Desktop ignores these flags via
  // the `md:` Tailwind variants below, so the same component serves
  // both layouts.
  const isMobileSidebarOpen = useWorkspaceStore((s) => s.isMobileSidebarOpen);
  const closeMobileSidebar = useWorkspaceStore((s) => s.closeMobileSidebar);

  /**
   * Real channel list, hydrated once from `/api/channels` on mount and
   * re-fetched whenever a future event invalidates it (currently never;
   * the MVP creates channels only via seed). Initial state holds the
   * fallback so the sidebar paints sensible content even before the
   * fetch resolves.
   */
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
        // Swallow network errors — fallback channels stay rendered.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * A channel row is active when:
   *   1. the store explicitly tracks it, OR
   *   2. the URL path matches `/channels/{id}` (covers initial render
   *      before the channel page hydrates the store).
   */
  const isChannelActive = (id: string): boolean => {
    if (currentChannelId === id) return true;
    return pathname === `/channels/${id}`;
  };

  const isBoardActive = pathname?.startsWith('/board') ?? false;

  return (
    <>
      {/* Mobile-only backdrop. Tapping it closes the drawer (P2 #5). */}
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
          // Layout: full-height column. On mobile the drawer slides in
          // from the left; on `md+` it sits in the layout flow as a
          // 240px static column.
          'flex h-screen w-60 shrink-0 flex-col gap-4 border-r border-border bg-surface px-3 py-4',
          // Mobile: fixed overlay, hidden by default behind a translate.
          'fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out md:static md:translate-x-0',
          isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        <WorkspaceHeader onNavigate={closeMobileSidebar} />

        {/* Mobile-only close button so users can dismiss without tapping
            the backdrop (better discoverability + accessibility). */}
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeMobileSidebar}
          className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-raised hover:text-foreground md:hidden"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <nav className="flex flex-1 flex-col gap-6 overflow-y-auto">
          <SidebarSection title="Channels">
            <ul className="flex flex-col gap-0.5">
              {channels.map((channel) => (
                <li key={channel.id}>
                  <Link
                    href={`/channels/${channel.id}`}
                    onClick={() => setCurrentChannel(channel.id)}
                    aria-current={isChannelActive(channel.id) ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors',
                      'hover:bg-surface-raised hover:text-foreground',
                      // Active row uses the Indigo primary accent
                      // (Requirements 9.1) — tinted background plus a
                      // crisper foreground so it reads as "selected".
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

          <SidebarSection title="AI Teammates">
            <ul className="flex flex-col gap-0.5">
              {MOCK_AI_TEAMMATES.map((ai) => {
                const isThinking = thinkingAIs.has(ai.id);
                return (
                  <li
                    key={ai.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                  >
                    <span
                      aria-hidden
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ai-gradient text-[10px] font-semibold text-white"
                    >
                      {ai.name.charAt(0)}
                    </span>
                    <span className="flex flex-1 flex-col leading-tight">
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
                          thinking…
                        </span>
                      ) : (
                        <span className="truncate text-[11px] text-muted-foreground/80">
                          {ai.role}
                        </span>
                      )}
                    </span>
                    <AIBadge label="AI" />
                  </li>
                );
              })}
            </ul>
          </SidebarSection>

          <SidebarSection title="Tasks">
            <Link
              href="/board"
              onClick={closeMobileSidebar}
              aria-current={isBoardActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors',
                'hover:bg-surface-raised hover:text-foreground',
                // Same Indigo accent treatment as active channels.
                isBoardActive && 'bg-primary/15 text-primary-200',
              )}
            >
              <ListChecks className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
              <span className="truncate">Kanban board</span>
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
      <span className="truncate leading-tight">AI-Native Team Workspace</span>
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
