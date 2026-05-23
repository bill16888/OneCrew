'use client';

import { useCallback, useEffect, useState } from 'react';
import { Hash } from 'lucide-react';

import { MessageRow } from '@/components/channel/MessageRow';
import { MessageComposer } from '@/components/channel/MessageComposer';
import {
  getClientSocket,
  subscribeToChannel,
} from '@/lib/realtime/client';
import { EVENTS, type MessageNewPayload } from '@/lib/realtime/events';

/**
 * Live channel view for `/channels/[channelId]` — task 3.9.
 *
 * Responsibilities (Requirements 2.3, 2.4, 4.5):
 *   1. Render the channel header + an ordered list of {@link MessageRow}
 *      entries seeded from the server-prefetched `initialMessages`.
 *   2. Subscribe to the singleton browser-side Socket.io client, join
 *      `channel:{channelId}` via `subscribe:channel`, and append every
 *      `message:new` payload whose `channelId` matches the current view.
 *   3. Wire {@link MessageComposer} to `POST /api/messages` so the
 *      authenticated user's submitted text reaches the service layer
 *      (which performs validation + persistence + broadcast).
 *
 * The component intentionally does **not** echo the user's own POST
 * back into local state — the same `message:new` event the server
 * broadcasts after a successful commit hydrates the timeline for every
 * subscriber, including the sender. A duplicate-id guard in the
 * realtime handler protects against the (rare) case of the same event
 * arriving twice during a reconnect window.
 *
 * The component is a pure client component: server-only data
 * (initial history, sender name lookup) is computed in the parent
 * server component and handed down as props.
 */

/**
 * Wire shape consumed by {@link ChannelView}. The server component
 * builds these from a `MessageService.listByChannel` result joined
 * with the workspace's user records so that each row already carries
 * the sender's display name and `isAI` flag.
 *
 * `createdAt` is an ISO 8601 string so the value serializes cleanly
 * across the RSC boundary (a `Date` would be lost) and matches the
 * realtime payload shape from {@link MessageNewPayload.createdAt}.
 */
export interface ChannelMessage {
  /** Message primary key (cuid). */
  id: string;
  /** Sender user id. */
  userId: string;
  /** Sender display name (resolved server-side). */
  userName: string;
  /** Plain-text body. */
  content: string;
  /** Mirrors `User.isAI` for the sender. */
  fromAI: boolean;
  /** ISO 8601 timestamp string. */
  createdAt: string;
}

/** Read-only directory used to resolve realtime senders' names + isAI. */
export type ChannelUserDirectory = Readonly<
  Record<string, { name: string; isAI: boolean }>
>;

export interface ChannelViewProps {
  /** Dynamic-route segment from `/channels/[channelId]`. */
  channelId: string;
  /** Server-prefetched message history, oldest first. */
  initialMessages: readonly ChannelMessage[];
  /**
   * Map of `userId` → `{ name, isAI }` covering every sender in
   * `initialMessages`. Used to resolve display names for live
   * `message:new` payloads, which carry only `userId` + `fromAI`.
   * Senders absent from the map fall back to their `userId` for the
   * displayed name (extremely rare in practice — every channel
   * member is part of the workspace user list).
   */
  userDirectory: ChannelUserDirectory;
}

/**
 * Render the live channel view. See module docs for the full contract.
 */
export function ChannelView({
  channelId,
  initialMessages,
  userDirectory,
}: ChannelViewProps): JSX.Element {
  const [messages, setMessages] = useState<readonly ChannelMessage[]>(
    () => initialMessages,
  );
  const [error, setError] = useState<string | null>(null);

  // Re-seed local state when the server hands us a fresh prefetch
  // (e.g. user navigates between two channels and the same component
  // instance is reused). Without this the timeline would be stuck on
  // the previous channel's history until a new realtime event arrives.
  useEffect(() => {
    setMessages(initialMessages);
    setError(null);
  }, [channelId, initialMessages]);

  // Subscribe to `message:new` for the active channel. We rely on the
  // singleton client (auto-reconnect, shared across the app) and
  // join the per-channel room via `subscribe:channel` on every mount
  // so reconnects after a transport drop end up in the right room.
  useEffect(() => {
    const socket = getClientSocket();
    subscribeToChannel(channelId);

    const handleMessageNew = (payload: MessageNewPayload): void => {
      // Defensive filter: the server only emits to the joined room,
      // but a stale subscription could still receive a different
      // channel's payload during a navigation transition.
      if (payload.channelId !== channelId) return;

      setMessages((prev) => {
        // Idempotency: ignore the (rare) duplicate delivery so the
        // user's own POST cannot render twice if a reconnect replays
        // the event we already appended.
        if (prev.some((m) => m.id === payload.id)) {
          return prev;
        }
        const meta = userDirectory[payload.userId];
        const next: ChannelMessage = {
          id: payload.id,
          userId: payload.userId,
          userName: meta?.name ?? payload.userId,
          content: payload.content,
          fromAI: payload.fromAI,
          createdAt: payload.createdAt,
        };
        return [...prev, next];
      });
    };

    socket.on(EVENTS.MessageNew, handleMessageNew);

    return () => {
      socket.off(EVENTS.MessageNew, handleMessageNew);
    };
  }, [channelId, userDirectory]);

  /**
   * Composer submission handler.
   *
   * POSTs to `/api/messages` with the session cookie attached. We do
   * not optimistically append the message locally — the service layer
   * broadcasts `message:new` after the row commits, which the
   * subscriber above appends with the canonical id / timestamp.
   *
   * Throws on a non-2xx response so {@link MessageComposer} keeps the
   * unsent text in its textarea (its local clear-on-success runs
   * after the awaited submit resolves successfully).
   */
  const handleSubmit = useCallback(
    async (input: { channelId: string; content: string }): Promise<void> => {
      setError(null);
      let response: Response;
      try {
        response = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(input),
        });
      } catch {
        const message = 'Network error while sending message.';
        setError(message);
        throw new Error(message);
      }

      if (!response.ok) {
        let message = `Failed to send message (HTTP ${response.status}).`;
        try {
          const body: unknown = await response.json();
          if (
            body !== null &&
            typeof body === 'object' &&
            'error' in body &&
            typeof (body as { error: unknown }).error === 'string'
          ) {
            message = (body as { error: string }).error;
          }
        } catch {
          // Non-JSON error body — keep the default HTTP-status message.
        }
        setError(message);
        throw new Error(message);
      }
    },
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <ChannelHeader channelId={channelId} />

      <ol
        aria-label={`Messages in #${channelId}`}
        className="flex flex-1 flex-col gap-1 overflow-y-auto py-2"
      >
        {messages.map((m) => (
          <li key={m.id}>
            <MessageRow
              id={m.id}
              userId={m.userId}
              userName={m.userName}
              content={m.content}
              fromAI={m.fromAI}
              createdAt={m.createdAt}
            />
          </li>
        ))}
      </ol>

      {error !== null && (
        <div
          role="alert"
          className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <MessageComposer
        channelId={channelId}
        onSubmit={handleSubmit}
        placeholder={`Message #${channelId}`}
      />
    </div>
  );
}

/** Sticky channel header showing the `#channel` name. */
function ChannelHeader({ channelId }: { channelId: string }): JSX.Element {
  return (
    <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
      <Hash className="h-4 w-4 text-muted-foreground" aria-hidden />
      <h1 className="text-sm font-semibold text-foreground">{channelId}</h1>
    </header>
  );
}
