import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * AI Badge — purple gradient pill rendered next to AI senders / AI tasks.
 *
 * Visual contract (Requirements 9.2, 9.3):
 *   - Gradient: #A855F7 → #6366F1 (Tailwind class: bg-ai-gradient)
 *   - White foreground text, small rounded-full chip
 *
 * Used by:
 *   - components/channel/MessageRow.tsx (AI sender badge)
 *   - components/board/TaskCard.tsx (isAITask = true)
 */
export interface AIBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

export function AIBadge({ label = 'AI', className, ...rest }: AIBadgeProps) {
  return (
    <span
      data-testid="ai-badge"
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-ai-gradient px-2 py-0.5 text-xs font-medium text-white',
        className,
      )}
      {...rest}
    >
      {label}
    </span>
  );
}
