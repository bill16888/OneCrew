/**
 * Channel service.
 *
 * Read-side service layer for channels and their message history. This
 * module is intentionally pure: it only reads from PostgreSQL via the
 * shared {@link prisma} singleton and does not perform any realtime
 * broadcasting. Broadcast on message creation is owned by
 * `MessageService` (see design.md, "Realtime" section).
 *
 * Reference:
 * - design.md → "Components and Interfaces" / "Realtime"
 * - requirements.md → Requirements 2.1, 2.2
 *
 * @module lib/services/channel.service
 */

import type { Channel, Message } from '@prisma/client';

import prisma from '@/lib/prisma';

/**
 * Options accepted by {@link getMessages}.
 */
export interface GetMessagesOptions {
  /**
   * Maximum number of messages to return.
   *
   * When omitted, every message in the channel is returned. When
   * provided, the **oldest** `limit` messages are returned (still in
   * ascending `createdAt` order) so that callers asking for "the first
   * N messages" get a stable prefix of the channel timeline.
   *
   * Must be a positive integer when provided; non-positive or
   * non-finite values are ignored and treated as "no limit".
   */
  limit?: number;
}

/**
 * List every channel that belongs to the given workspace, ordered by
 * `createdAt` ascending so the UI can render channels in the order they
 * were created.
 *
 * Validates: Requirements 2.1.
 *
 * @param workspaceId - The workspace whose channels should be returned.
 * @returns Channels belonging to `workspaceId`, oldest first. Returns
 *   an empty array when the workspace has no channels (or does not
 *   exist); the caller is responsible for verifying workspace
 *   existence if that distinction matters.
 *
 * @example
 * ```ts
 * const channels = await ChannelService.listByWorkspace(WORKSPACE_ID);
 * ```
 */
export async function listByWorkspace(workspaceId: string): Promise<Channel[]> {
  return prisma.channel.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Return messages of the given channel in `createdAt` ascending order
 * (oldest first), which matches the natural reading order in the UI.
 *
 * By default every message in the channel is returned. Pass
 * {@link GetMessagesOptions.limit} to cap the result size.
 *
 * Validates: Requirements 2.2.
 *
 * @param channelId - The channel whose messages should be returned.
 * @param opts - Optional pagination controls.
 * @returns Messages of `channelId` ordered oldest-first. Returns an
 *   empty array when the channel has no messages (or does not exist).
 *
 * @example
 * ```ts
 * const all = await ChannelService.getMessages(channelId);
 * const firstFifty = await ChannelService.getMessages(channelId, { limit: 50 });
 * ```
 */
export async function getMessages(
  channelId: string,
  opts?: GetMessagesOptions,
): Promise<Message[]> {
  const rawLimit = opts?.limit;
  const take =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : undefined;

  return prisma.message.findMany({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
    ...(take !== undefined ? { take } : {}),
  });
}

/**
 * Aggregated namespace export so callers can use either named imports
 * or the `ChannelService.method(...)` style favored across the spec.
 */
export const ChannelService = {
  listByWorkspace,
  getMessages,
} as const;
