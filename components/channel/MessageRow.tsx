import { AIBadge } from '@/components/ui/AIBadge';
import { TimeAgo } from '@/components/ui/TimeAgo';
import { cn } from '@/lib/utils';

/**
 * MessageRow — a single message in a channel timeline.
 *
 * Visual contract (Requirements 4.5, 9.2, 9.4):
 *   - When `fromAI` is true, the row gets the global `.ai-message-accent`
 *     utility (left vertical purple bar + left padding, defined in
 *     `app/globals.css` as `border-l-2 border-ai pl-3`, where `border-ai`
 *     resolves to `#A855F7`) and an `AIBadge` is rendered next to the
 *     sender name. The AI avatar reuses the purple→indigo
 *     `bg-ai-gradient` (`#A855F7 → #6366F1`) so the row reads as
 *     AI-originated even without a profile picture.
 *   - Human messages render with no left accent and no badge.
 *   - The header timestamp is rendered via {@link TimeAgo} so all
 *     time displays in the workspace use a uniform `date-fns`
 *     relative-time label (Requirement 9.4).
 *
 * This component is presentational: it does not fetch data and does
 * not subscribe to realtime events. The channel page hands it props
 * derived from either mock data (task 2.4) or the live `message:new`
 * stream (task 3.9).
 */

/** Props for {@link MessageRow}. Mirrors the eventual `message:new` payload. */
export interface MessageRowProps {
  /** Message id (used as React key by the parent; not rendered). */
  id: string;
  /** User id of the sender. Reserved for future @-mentions / linking. */
  userId: string;
  /** Display name shown on the row header. */
  userName: string;
  /** Plain-text body. Rendered as text — no markdown parsing in MVP. */
  content: string;
  /** True iff the sender is an AI colleague (`User.isAI = true`). */
  fromAI: boolean;
  /** Server-assigned creation time. Accepts a Date or an ISO string. */
  createdAt: Date | string;
}

/**
 * Render one channel message.
 *
 * @param props - {@link MessageRowProps}
 * @returns A list item-friendly `<article>` for a message row.
 */
export function MessageRow(props: MessageRowProps): JSX.Element {
  const { userName, content, fromAI, createdAt } = props;

  return (
    <article
      data-testid="message-row"
      data-from-ai={fromAI ? 'true' : 'false'}
      className={cn(
        'flex gap-3 px-4 py-3',
        // Requirement 9.2: AI messages render a vertical purple bar on
        // the left edge. The `.ai-message-accent` utility lives in
        // app/globals.css and resolves to `border-l-2 border-ai pl-3`.
        fromAI && 'ai-message-accent',
      )}
    >
      <Avatar name={userName} fromAI={fromAI} />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-foreground">{userName}</span>
          {fromAI && <AIBadge label="AI" />}
          <TimeAgo
            date={createdAt}
            className="text-xs text-muted-foreground"
          />
        </header>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
          {content}
        </p>
      </div>
    </article>
  );
}

interface AvatarProps {
  name: string;
  fromAI: boolean;
}

/**
 * Initials avatar. AI senders get the purple gradient surface so the
 * row reads as AI-originated even without a profile picture.
 */
function Avatar({ name, fromAI }: AvatarProps): JSX.Element {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        fromAI
          ? 'bg-ai-gradient text-white'
          : 'bg-surface-raised text-foreground/80',
      )}
    >
      {initial}
    </span>
  );
}
