'use client';

import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';

/**
 * @file First-paint banner asking for desktop Notification permission
 * (Phase 1 Req 18.1).
 *
 * Shows only when:
 *   - the browser supports the Notification API,
 *   - permission is still `default` (not granted/denied), and
 *   - the user has not previously dismissed the banner (localStorage).
 *
 * Dismissal persists in localStorage so the banner is shown at most
 * once per browser until storage is cleared.
 */

const DISMISS_KEY = 'kiro.notifications.bannerDismissed';

export function NotificationPermissionBanner(): JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof Notification === 'undefined'
    ) {
      return;
    }
    const dismissed = window.localStorage.getItem(DISMISS_KEY) === 'true';
    if (!dismissed && Notification.permission === 'default') {
      setVisible(true);
    }
  }, []);

  function dismiss(): void {
    window.localStorage.setItem(DISMISS_KEY, 'true');
    setVisible(false);
  }

  async function requestPermission(): Promise<void> {
    try {
      await Notification.requestPermission();
    } catch {
      // Ignore — user can re-enable via browser settings later.
    } finally {
      // Whatever the choice, don't nag again.
      dismiss();
    }
  }

  if (!visible) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-border bg-surface-raised px-4 py-2 text-sm"
    >
      <Bell className="h-4 w-4 shrink-0 text-brand" aria-hidden />
      <span className="flex-1 text-foreground/90">
        开启桌面通知，AI 需要你决策或完成任务时第一时间提醒你。
      </span>
      <button
        type="button"
        onClick={() => void requestPermission()}
        className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white hover:opacity-90"
      >
        开启
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="关闭"
        className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
