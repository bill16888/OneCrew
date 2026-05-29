import { create } from 'zustand';

import type { NotificationNewPayload } from '@/lib/realtime/events';

/**
 * @file In-app notification store (Phase 1 Req 18.5).
 *
 * Holds the recent `notification:new` events so the UI can render an
 * in-app notification panel even when the browser denied desktop
 * Notification permission. Transient UI state only — not persisted.
 */

export interface InAppNotification extends NotificationNewPayload {
  /** Client-assigned id for list keys + read tracking. */
  localId: string;
  read: boolean;
}

interface NotificationState {
  items: InAppNotification[];
  unreadCount: number;
}

interface NotificationActions {
  /** Prepend a notification (newest first), capping the list at 50. */
  push: (payload: NotificationNewPayload) => void;
  /** Mark every notification read. */
  markAllRead: () => void;
  /** Clear the list. */
  clear: () => void;
}

const MAX_ITEMS = 50;

export const useNotificationStore = create<
  NotificationState & NotificationActions
>((set) => ({
  items: [],
  unreadCount: 0,

  push: (payload) =>
    set((state) => {
      const item: InAppNotification = {
        ...payload,
        localId: `${payload.category}-${payload.createdAt}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        read: false,
      };
      return {
        items: [item, ...state.items].slice(0, MAX_ITEMS),
        unreadCount: state.unreadCount + 1,
      };
    }),

  markAllRead: () =>
    set((state) => ({
      items: state.items.map((i) => ({ ...i, read: true })),
      unreadCount: 0,
    })),

  clear: () => set(() => ({ items: [], unreadCount: 0 })),
}));
