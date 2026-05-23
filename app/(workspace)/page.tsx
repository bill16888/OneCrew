import Link from 'next/link';
import { ArrowRight, Hash, LayoutGrid } from 'lucide-react';
import { AIBadge } from '@/components/ui/AIBadge';

/**
 * Workspace home (`/`) — the landing view inside the `(workspace)` route
 * group. Sits alongside the sidebar from `(workspace)/layout.tsx`.
 *
 * Task 2.3 keeps this intentionally lightweight: a welcome banner plus
 * direct entry points to the default channels and the kanban board. No
 * data fetching here — the sidebar already lists channels and the real
 * channel page is built in task 2.4.
 *
 * Visual: dark canvas (#0A0A0A) inherited from the root layout; cards
 * sit on the slightly raised `bg-surface` (#111113) for contrast
 * (Requirement 9.1).
 */

interface ChannelEntry {
  id: string;
  name: string;
  blurb: string;
}

// Mirrors the sidebar's mock channels (and the seed data in
// `prisma/seed.ts`) until task 3.6 wires real `/api/channels` data.
const FEATURED_CHANNELS: readonly ChannelEntry[] = [
  { id: 'general', name: 'general', blurb: 'Team-wide announcements and casual chat.' },
  { id: 'engineering', name: 'engineering', blurb: 'Eng standups, code reviews, AI work.' },
];

export default function WorkspaceHomePage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-8 py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <AIBadge label="AI-Native" />
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Workspace
          </span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Welcome back
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Channels, the kanban board, and your AI teammates Ada and Hopper are
          all on the left. Pick a channel to jump back into a thread, or open
          the board to see what&rsquo;s in flight.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          Channels
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {FEATURED_CHANNELS.map((channel) => (
            <li key={channel.id}>
              <Link
                href={`/channels/${channel.id}`}
                className="group flex h-full flex-col gap-1 rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-primary/60 hover:bg-surface-raised"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Hash className="h-4 w-4 opacity-70" aria-hidden />
                  {channel.name}
                  <ArrowRight
                    className="ml-auto h-4 w-4 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100"
                    aria-hidden
                  />
                </span>
                <span className="text-xs text-muted-foreground">{channel.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          Tasks
        </h2>
        <Link
          href="/board"
          className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-primary/60 hover:bg-surface-raised"
        >
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 text-primary"
          >
            <LayoutGrid className="h-5 w-5" />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-medium text-foreground">Open the kanban board</span>
            <span className="text-xs text-muted-foreground">
              Backlog · In Progress · In Review · Done
            </span>
          </span>
          <ArrowRight
            className="ml-auto h-4 w-4 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100"
            aria-hidden
          />
        </Link>
      </section>
    </div>
  );
}
