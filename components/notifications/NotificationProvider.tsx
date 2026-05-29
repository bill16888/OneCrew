'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

import { getClientSocket } from '@/lib/realtime/client';
import { EVENTS, type NotificationNewPayload } from '@/lib/realtime/events';
import { useNotificationStore } from '@/store/useNotificationStore';

/**
 * @file Client-side notification handler (Phase 1 Req 18).
 *
 * Mounted once at the workspace layout. Subscribes to `notification:new`
 * and, for each event:
 *   1. Pushes it into the in-app notification store (always — works even
 *      without desktop permission, Req 18.5).
 *   2. If desktop Notification permission is granted, fires a
 *      `new Notification()` — throttled to at most one per category per
 *      minute (Req 18.3) and tagged per category so a newer one replaces
 *      the older instead of stacking (Req 18.4).
 *   3. Clicking the desktop notification focuses the tab and navigates
 *      to the payload's `href` (Req 18.5).
 *
 * On first mount it shows a dismissible permission banner (handled by
 * {@link NotificationPermissionBanner}) — kept separate so this provider
 * stays render-free.
 *
 * Renders nothing.
 */
export function NotificationProvider(): null {
  const router = useRouter();
  const push = useNotificationStore((s) => s.push);
  // Per-category throttle: last fire timestamp (ms).
  const lastFiredRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const THROTTLE_MS = 60_000;

    function handle(payload: NotificationNewPayload): void {
      // Always record in-app (Req 18.5).
      push(payload);

      // Desktop notification is best-effort + permission-gated.
      if (
        typeof window === 'undefined' ||
        typeof Notification === 'undefined' ||
        Notification.permission !== 'granted'
      ) {
        return;
      }

      const now = Date.now();
      const last = lastFiredRef.current[payload.category] ?? 0;
      if (now - last < THROTTLE_MS) {
        // Throttled — the in-app store still captured it above.
        return;
      }
      lastFiredRef.current[payload.category] = now;

      try {
        const notification = new Notification(payload.title, {
          body: payload.body,
          // Same tag per category → a newer notification replaces the
          // previous one rather than stacking (Req 18.4).
          tag: `kiro-${payload.category}`,
        });
        notification.onclick = () => {
          window.focus();
          router.push(payload.href);
          notification.close();
        };
      } catch {
        // Some browsers throw if Notification is constructed in an
        // unsupported context; the in-app store already has it.
      }
    }

    const socket = getClientSocket();
    socket.on(EVENTS.NotificationNew, handle);
    return () => {
      socket.off(EVENTS.NotificationNew, handle);
    };
  }, [push, router]);

  return null;
}
