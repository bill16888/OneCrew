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

import type { Channel, ChannelMember, Message } from '@prisma/client';

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
 * Member descriptor returned by {@link listMembers} — joins the
 * membership row with the minimal user fields the UI renders.
 */
export interface ChannelMemberView {
  userId: string;
  name: string;
  isAI: boolean;
  role: string;
  joinedAt: string;
}

/**
 * Return true iff `userId` is a member of `channelId`. Used by
 * `MessageService.create` (membership enforcement, Phase 1 Req 17.2)
 * and the members API.
 */
export async function isMember(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.channelMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
    select: { channelId: true },
  });
  return row !== null;
}

/**
 * List every member of a channel, newest joins last, with the user's
 * name + isAI flag for rendering. Ordered by `joinedAt` ascending.
 *
 * Validates: Phase 1 Req 17.4.
 */
export async function listMembers(
  channelId: string,
): Promise<ChannelMemberView[]> {
  const rows = await prisma.channelMember.findMany({
    where: { channelId },
    orderBy: { joinedAt: 'asc' },
    include: { user: { select: { name: true, isAI: true } } },
  });
  return rows.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    isAI: r.user.isAI,
    role: r.role,
    joinedAt: r.joinedAt.toISOString(),
  }));
}

/**
 * Add a user to a channel. Idempotent: re-adding an existing member is
 * a no-op (upsert). `role` is derived from the user's `isAI` flag so
 * the membership row stays consistent with the user record.
 *
 * Validates: Phase 1 Req 17.5.
 *
 * @throws when the user or channel does not exist (Prisma FK error).
 */
export async function addMember(
  channelId: string,
  userId: string,
): Promise<ChannelMember> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAI: true },
  });
  if (!user) {
    throw new Error(`User ${userId} does not exist.`);
  }
  const role = user.isAI ? 'ai' : 'human';
  return prisma.channelMember.upsert({
    where: { channelId_userId: { channelId, userId } },
    update: { role },
    create: { channelId, userId, role },
  });
}

/**
 * Remove a user from a channel. Idempotent: removing a non-member is a
 * no-op (returns false). Returns true when a row was actually deleted.
 */
export async function removeMember(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const result = await prisma.channelMember.deleteMany({
    where: { channelId, userId },
  });
  return result.count > 0;
}

/**
 * Aggregated namespace export so callers can use either named imports
 * or the `ChannelService.method(...)` style favored across the spec.
 */
export const ChannelService = {
  listByWorkspace,
  getMessages,
  isMember,
  listMembers,
  addMember,
  removeMember,
} as const;
