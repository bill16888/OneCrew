import {
  ChannelView,
  type ChannelMessage,
  type ChannelUserDirectory,
} from '@/components/channel/ChannelView';
import prisma from '@/lib/prisma';
import { MessageService } from '@/lib/services/message.service';

/**
 * Channel page (`/channels/[channelId]`) — task 3.9.
 *
 * Server component contract:
 *   1. Prefetch the channel's message history via the
 *      {@link MessageService.listByChannel} service call (oldest-first
 *      ordering — Requirement 2.2).
 *   2. Resolve every sender's display name + `isAI` flag in a single
 *      round-trip so the initial render of {@link ChannelView} carries
 *      the same shape downstream `message:new` events do.
 *   3. Hand both off to the client {@link ChannelView}, which subscribes
 *      to `message:new` for live appends and POSTs new submissions to
 *      `/api/messages` (Requirements 2.3, 2.4, 4.5).
 *
 * Authentication for this route is enforced at two layers:
 *   - `middleware.ts` redirects unauthenticated requests to `/login`.
 *   - `MessageService.listByChannel` runs server-side; the only data
 *     it returns is the channel's persisted messages (no PII beyond
 *     what the user already has access to).
 *
 * The dynamic route segment may be either a database channel id
 * (cuid, what `MessageService` expects) or a friendly slug from the
 * sidebar (e.g. `general` / `engineering`). When the segment does not
 * match a real id, we transparently look up the channel by name so
 * the existing sidebar links keep working without changes.
 */

interface ChannelPageProps {
  // Next.js 15: dynamic route `params` is asynchronous.
  params: Promise<{ channelId: string }>;
}

/**
 * Translate the URL segment into the actual `Channel.id` to query
 * against. The sidebar currently links to friendly slugs (`general`,
 * `engineering`, …) while the database stores cuids; we accept both
 * so a future swap to real ids is a one-line change in the sidebar.
 *
 * Returns `null` when the segment matches neither a known id nor a
 * known channel name in the workspace.
 */
async function resolveChannelId(segment: string): Promise<string | null> {
  // Fast path: the segment is already a stored channel id.
  const byId = await prisma.channel.findUnique({
    where: { id: segment },
    select: { id: true },
  });
  if (byId !== null) return byId.id;

  // Fallback: treat the segment as a friendly name. The seed creates
  // `#general` / `#engineering`; the sidebar's mock list mirrors that
  // (with the leading `#` stripped). We don't restrict by workspace
  // because the MVP runs a single workspace; if multiple workspaces
  // ever share names this would need a `workspaceId` filter.
  const byName = await prisma.channel.findFirst({
    where: { name: segment },
    select: { id: true },
  });
  return byName?.id ?? null;
}

export default async function ChannelPage({
  params,
}: ChannelPageProps): Promise<JSX.Element> {
  const { channelId: segment } = await params;

  const resolvedChannelId = await resolveChannelId(segment);

  // When the segment doesn't resolve, we still render the shell with
  // an empty timeline so the user sees a usable composer instead of
  // a hard 404. The composer's POST to `/api/messages` will surface
  // a meaningful error on submit if the channel id is invalid.
  if (resolvedChannelId === null) {
    const emptyDirectory: ChannelUserDirectory = {};
    return (
      <ChannelView
        channelId={segment}
        initialMessages={[]}
        userDirectory={emptyDirectory}
      />
    );
  }

  // Step 1: pull the message history for the resolved channel.
  const persistedMessages = await MessageService.listByChannel(
    resolvedChannelId,
  );

  // Step 2: resolve every sender's display name + `isAI` flag in a
  // single round-trip. We deduplicate the `userId` set first so the
  // `IN (...)` clause stays bounded by distinct senders rather than
  // total message count.
  const senderIds = Array.from(
    new Set(persistedMessages.map((m) => m.userId)),
  );

  const senderRecords = senderIds.length === 0
    ? []
    : await prisma.user.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, name: true, isAI: true },
      });

  const userDirectory: ChannelUserDirectory = Object.fromEntries(
    senderRecords.map((u) => [u.id, { name: u.name, isAI: u.isAI }]),
  );

  // Step 3: project the persisted rows into the wire shape the client
  // component consumes. Senders absent from the directory (e.g. a
  // user record was deleted while a message survives) fall back to
  // their `userId` and a `false` AI flag — the same fallback the
  // realtime handler uses for unknown ids.
  const initialMessages: readonly ChannelMessage[] = persistedMessages.map(
    (m) => {
      const sender = userDirectory[m.userId];
      return {
        id: m.id,
        userId: m.userId,
        userName: sender?.name ?? m.userId,
        content: m.content,
        fromAI: sender?.isAI ?? false,
        createdAt: m.createdAt.toISOString(),
      };
    },
  );

  return (
    <ChannelView
      channelId={resolvedChannelId}
      initialMessages={initialMessages}
      userDirectory={userDirectory}
    />
  );
}
