import '../../setup';

/**
 * @file Tests for the in-app notification store (Phase 1 Req 18.5).
 *
 * The store backs the in-app notification panel that works even when
 * desktop Notification permission is denied. Covers push ordering,
 * unread tracking, the 50-item cap, and markAllRead/clear.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { NotificationNewPayload } from '@/lib/realtime/events';
import { useNotificationStore } from '@/store/useNotificationStore';

function makePayload(
  overrides: Partial<NotificationNewPayload> = {},
): NotificationNewPayload {
  return {
    category: 'approval',
    title: 't',
    body: 'b',
    href: '/dashboard',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  useNotificationStore.getState().clear();
});

describe('useNotificationStore', () => {
  it('pushes newest-first and tracks unread count', () => {
    const { push } = useNotificationStore.getState();
    push(makePayload({ title: 'first' }));
    push(makePayload({ title: 'second' }));

    const state = useNotificationStore.getState();
    expect(state.items).toHaveLength(2);
    expect(state.items[0].title).toBe('second'); // newest first
    expect(state.unreadCount).toBe(2);
  });

  it('assigns unique localIds + read=false on push', () => {
    const { push } = useNotificationStore.getState();
    push(makePayload());
    push(makePayload());
    const { items } = useNotificationStore.getState();
    expect(items[0].localId).not.toBe(items[1].localId);
    expect(items.every((i) => i.read === false)).toBe(true);
  });

  it('markAllRead flips read flags and zeroes unreadCount', () => {
    const { push, markAllRead } = useNotificationStore.getState();
    push(makePayload());
    push(makePayload());
    markAllRead();
    const state = useNotificationStore.getState();
    expect(state.unreadCount).toBe(0);
    expect(state.items.every((i) => i.read)).toBe(true);
  });

  it('caps the list at 50 items', () => {
    const { push } = useNotificationStore.getState();
    for (let i = 0; i < 60; i++) push(makePayload({ title: `n${i}` }));
    const { items } = useNotificationStore.getState();
    expect(items).toHaveLength(50);
    // Newest retained, oldest dropped.
    expect(items[0].title).toBe('n59');
    expect(items.some((i) => i.title === 'n9')).toBe(false);
  });

  it('clear empties the store', () => {
    const { push, clear } = useNotificationStore.getState();
    push(makePayload());
    clear();
    const state = useNotificationStore.getState();
    expect(state.items).toHaveLength(0);
    expect(state.unreadCount).toBe(0);
  });
});
