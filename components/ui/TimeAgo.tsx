'use client';

import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

/**
 * Props for the {@link TimeAgo} component.
 */
export interface TimeAgoProps {
  /**
   * The point in time to render relative to "now".
   *
   * Accepts either a {@link Date} instance or an ISO 8601 string. String
   * inputs are converted via `new Date(s)`.
   */
  date: Date | string;
  /**
   * Optional class name forwarded to the underlying `<time>` element.
   */
  className?: string;
  /**
   * How frequently (in milliseconds) the component should re-render to
   * refresh the relative-time label. Defaults to 60_000 (one minute).
   */
  intervalMs?: number;
}

/**
 * `<TimeAgo />` — renders a relative-time label such as "3 minutes ago".
 *
 * Validates: Requirements 9.4 (Property 27).
 *
 * Behavior:
 *   - Uses `date-fns`' `formatDistanceToNow(d, { addSuffix: true })` to
 *     produce the human-readable relative time.
 *   - Renders a semantic `<time>` element with `dateTime` set to the ISO
 *     representation of `date`, preserving machine-readable timestamps.
 *   - Re-renders on a fixed interval (default 60s) so the label stays
 *     fresh without a page reload. Client component because the label
 *     depends on the current wall-clock time.
 */
export function TimeAgo({ date, className, intervalMs = 60_000 }: TimeAgoProps) {
  const resolved = typeof date === 'string' ? new Date(date) : date;

  // SSR / first-paint guard: `formatDistanceToNow` depends on the
  // current wall-clock time, which is necessarily different between
  // the server render and the browser's first render moments later.
  // That mismatch trips React's hydration check (Minified React
  // error #418) and aborts the entire client tree — including
  // `<ChannelView>`, which means Socket.io never subscribes and
  // realtime events never arrive. We dodge it by rendering a stable
  // placeholder on first render, then swap to the real label on
  // mount via `useEffect`. Subsequent ticks update the label normally.
  const [mounted, setMounted] = useState(false);
  // Used only to force re-renders on the interval tick.
  const [, setTick] = useState(0);

  useEffect(() => {
    setMounted(true);
    if (intervalMs <= 0) return;
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  const iso = resolved.toISOString();
  const label = mounted
    ? formatDistanceToNow(resolved, { addSuffix: true })
    : '';

  return (
    <time dateTime={iso} className={cn(className)} suppressHydrationWarning>
      {label}
    </time>
  );
}

export default TimeAgo;
