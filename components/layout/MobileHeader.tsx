'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

/**
 * Mobile-only top bar (P2 task #5).
 *
 * Visible at `<md` only. Contains:
 *   - Hamburger button (left) → opens the workspace sidebar drawer.
 *   - Current location label (center) — the active channel name when
 *     the user is in a channel route, the section name otherwise.
 *   - User avatar placeholder (right) — non-interactive in the MVP;
 *     the dropdown menu is left as a backlog item.
 *
 * Uses Tailwind's responsive utilities (`md:hidden`) instead of media
 * queries so the bar disappears completely on tablet / desktop, and
 * the sidebar takes its static `md+` position. No JS-driven viewport
 * detection means SSR / hydration is conflict-free.
 *
 * Validates: P2 task #5 — mobile shell.
 */

/**
 * Heuristic to render a friendly title for the current route. Pulls
 * the channel id segment when on `/channels/<id>` so the user sees
 * `#general` rather than just "Channels".
 */
function deriveLocationLabel(pathname: string | null): string {
  if (!pathname) return 'Workspace';
  if (pathname.startsWith('/channels/')) {
    const segment = pathname.split('/').at(2) ?? '';
    return segment ? `#${segment}` : 'Channels';
  }
  if (pathname.startsWith('/board')) return 'Kanban board';
  if (pathname === '/' || pathname === '') return 'Workspace';
  return pathname;
}

interface MobileHeaderProps {
  /** Current logged-in user's display initial; rendered in the avatar chip. */
  userInitial?: string;
}

export function MobileHeader({ userInitial }: MobileHeaderProps): JSX.Element {
  const pathname = usePathname();
  const toggleMobileSidebar = useWorkspaceStore((s) => s.toggleMobileSidebar);

  const label = deriveLocationLabel(pathname ?? null);
  const initial = (userInitial ?? '').trim().charAt(0).toUpperCase() || 'U';

  return (
    <header
      role="banner"
      className={cn(
        // Fixed 48px height (3rem) — matches the spec's mobile target
        // and keeps the main content's `flex-1` math simple.
        'flex h-12 w-full shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3',
        // Mobile-only: hidden on `md+` where the sidebar is always
        // visible inline.
        'md:hidden',
      )}
    >
      <button
        type="button"
        aria-label="Open navigation"
        onClick={toggleMobileSidebar}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>

      <div className="min-w-0 flex-1 text-center text-sm font-semibold text-foreground">
        <span className="truncate">{label}</span>
      </div>

      {/*
        Avatar placeholder: kept non-interactive in the MVP so we don't
        ship a half-baked menu. The chip uses the AI gradient when no
        initial is available so the bar always renders something
        recognizable as the user's identity.
      */}
      <span
        aria-hidden
        title="Account"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
      >
        {initial}
      </span>
    </header>
  );
}
