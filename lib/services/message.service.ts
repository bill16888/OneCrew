/**
 * Message service.
 *
 * Owns the write-side and read-side logic for channel messages:
 *   - {@link create}: validates the payload, persists a new {@link Message}
 *     row, then broadcasts `message:new` to `channel:{channelId}` with a
 *     `fromAI` flag derived from the sender's `User.isAI` column.
 *   - {@link listByChannel}: returns every message in the channel ordered
 *     by `createdAt` ascending (oldest first).
 *
 * The realtime broadcast is **only** emitted after the database write
 * commits. Validation failures and persistence failures both rethrow the
 * original error and emit nothing — see Requirements 8.4 / 10.4.
 *
 * Reference:
 * - design.md → "Components and Interfaces" / "Realtime"
 * - requirements.md → Requirements 2.3, 2.4, 2.5, 2.6, 2.7, 4.4, 8.4, 10.4
 *
 * @module lib/services/message.service
 */

import type { Message, Prisma } from '@prisma/client';

import { logger } from '@/lib/logger';
import { agenticEmitter } from '@/lib/loop/emitter';
import prisma from '@/lib/prisma';
import { EVENTS, type MessageNewPayload } from '@/lib/realtime/events';
import { getIO } from '@/lib/realtime/io';

/**
 * Default workspace identifier used when `process.env.WORKSPACE_ID` is
 * unset. Mirrors the single-workspace MVP assumption (Requirement 1.7)
 * and is kept aligned with `lib/services/task.service.ts`,
 * `lib/services/approval.service.ts`, and `prisma/seed.ts`.
 */
const DEFAULT_WORKSPACE_ID = 'ws_default';

/**
 * Resolve the active workspace id from the environment, falling back
 * to {@link DEFAULT_WORKSPACE_ID}. Read lazily (per call) so test
 * harnesses can mutate `process.env.WORKSPACE_ID` between invocations.
 */
function resolveWorkspaceId(): string {
  const fromEnv = process.env.WORKSPACE_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORKSPACE_ID;
}

/**
 * Maximum allowed length (in UTF-16 code units) for a single message body.
 * Mirrors the limit on `send_channel_message.input_schema.content` so the
 * AI tool surface and human surface share the same upper bound.
 *
 * Validates: Requirements 2.6.
 */
export const MESSAGE_MAX_LENGTH = 8000;

/**
 * Validation error raised when a caller passes an invalid `content`
 * string to {@link create}. Route handlers use `instanceof
 * ValidationError` to translate into HTTP 400 responses.
 *
 * Kept as a local class so the service does not depend on a generic
 * error utility module that does not yet exist.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Coerce a persisted Prisma JSON value into the wire shape accepted by
 * {@link MessageNewPayload.metadata} (`Record<string, unknown> | null`).
 *
 * Prisma stores `metadata` as `Json?`, which means reads can yield any
 * JSON value (object, array, string, number, boolean, null) or
 * `undefined` when the column was never set on the row. The realtime
 * payload contract narrows this to "object or null"; non-object values
 * (including arrays) are flattened to `null` so consumers always get a
 * keyed structure or no metadata at all.
 */
function toMetadataPayload(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> | null {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Build the wire payload for a `message:new` event from a persisted
 * {@link Message} row plus the sender's `isAI` flag.
 *
 * Dates are serialized as ISO 8601 strings because Socket.io broadcasts
 * JSON over the wire.
 */
function toMessageNewPayload(
  message: Message,
  fromAI: boolean,
): MessageNewPayload {
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    content: message.content,
    metadata: toMetadataPayload(message.metadata),
    createdAt: message.createdAt.toISOString(),
    fromAI,
  };
}

/**
 * Broadcast a `message:new` event to the per-channel room. No-ops when
 * the Socket.io server has not been initialized yet (e.g. during unit
 * tests or before `server.ts` wires the realtime layer).
 *
 * Callers MUST only invoke this after a successful database commit so
 * we never broadcast an un-persisted message (Requirements 8.4 / 10.4).
 */
function broadcastMessageNew(message: Message, fromAI: boolean): void {
  const io = getIO();
  if (!io) return;
  const room = `channel:${message.channelId}`;
  io.to(room).emit(EVENTS.MessageNew, toMessageNewPayload(message, fromAI));
}

/**
 * Input accepted by {@link create}.
 */
export interface CreateMessageInput {
  /** Target channel id (cuid). */
  channelId: string;
  /** Sender user id (cuid). May be a human or an AI colleague. */
  userId: string;
  /**
   * Message body. Must satisfy `content.trim().length > 0` and
   * `content.length <= MESSAGE_MAX_LENGTH`; otherwise the call is
   * rejected with a {@link ValidationError} and nothing is persisted.
   */
  content: string;
  /**
   * Optional structured metadata persisted to the `Message.metadata`
   * JSON column. Only object-shaped metadata is reflected back to
   * realtime subscribers (see {@link toMetadataPayload}).
   */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Validate the message body against the rules from Requirements 2.6 and
 * 2.7. Throws a {@link ValidationError} on failure; returns nothing on
 * success.
 *
 * - Reject when `content.trim().length === 0` (empty or whitespace-only).
 * - Reject when `content.length > MESSAGE_MAX_LENGTH` (raw length, not
 *   trimmed length, so trailing whitespace still counts toward the cap).
 *
 * Validates: Requirements 2.6, 2.7.
 */
function assertValidContent(content: string): void {
  if (content.trim().length === 0) {
    throw new ValidationError('Message content must not be empty.');
  }
  if (content.length > MESSAGE_MAX_LENGTH) {
    throw new ValidationError(
      `Message content exceeds the ${MESSAGE_MAX_LENGTH}-character limit.`,
    );
  }
}

/**
 * Create a new channel message.
 *
 * Steps:
 *   1. Validate `content` against the length / non-blank rules. Failures
 *      throw a {@link ValidationError} **before** any database write,
 *      so neither persistence nor a realtime broadcast occurs.
 *   2. Persist the {@link Message} row, joining the sender so we can
 *      read back `User.isAI` in a single round-trip via Prisma's
 *      `include`.
 *   3. After the write commits, broadcast `message:new` to the
 *      `channel:{channelId}` room with `fromAI = sender.isAI`. If the
 *      Socket.io server is not yet initialized, the broadcast is a
 *      no-op (the persistence is unaffected).
 *
 * Persistence failures rethrow the original Prisma error and the
 * realtime layer is **not** invoked, satisfying Requirements 8.4 / 10.4.
 *
 * Validates: Requirements 2.3, 2.4, 2.5, 2.6, 2.7, 4.4, 8.4, 10.4.
 *
 * @param input - {@link CreateMessageInput} describing the new message.
 * @returns The persisted {@link Message} record.
 * @throws {ValidationError} when `content` is blank or exceeds the
 *   length cap. Nothing is persisted and no event is emitted.
 * @throws The original Prisma error when persistence fails. The
 *   realtime layer is not invoked in that case.
 *
 * @example
 * ```ts
 * const message = await MessageService.create({
 *   channelId,
 *   userId: humanUser.id,
 *   content: 'Hello, team!',
 * });
 * ```
 */
export async function create(input: CreateMessageInput): Promise<Message> {
  assertValidContent(input.content);

  // Verify the target channel belongs to the active workspace before
  // we attempt the insert. The single-workspace MVP makes this a
  // tautology today, but baking the check in now ensures the
  // multi-workspace migration cannot accidentally let a user post into
  // a channel they do not own (audit finding H4).
  const workspaceId = resolveWorkspaceId();
  const channel = await prisma.channel.findFirst({
    where: { id: input.channelId, workspaceId },
    select: { id: true },
  });
  if (!channel) {
    throw new ValidationError(
      `Channel ${input.channelId} does not exist in this workspace.`,
    );
  }

  // Single round-trip: insert the message and read back the sender's
  // isAI flag via Prisma's `include`. Avoids a second query while
  // keeping the return type aligned with the {@link Message} contract.
  const created = await prisma.message.create({
    data: {
      channelId: input.channelId,
      userId: input.userId,
      content: input.content,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
    include: { user: { select: { isAI: true } } },
  });

  // Strip the `user` relation before returning so the public contract
  // remains a plain {@link Message}; keep `fromAI` locally for the
  // broadcast payload.
  const { user, ...message } = created;
  broadcastMessageNew(message, user.isAI);

  // Wake up any AI colleague this message @-mentions, but only when
  // the sender is human. AI-to-AI mentions would otherwise spiral
  // into self-driving loops (e.g. Ada @Hopper triggers a Hopper
  // cycle that mentions @Ada that triggers an Ada cycle ...). Routing
  // human-driven mentions through the same `wakeup` channel that the
  // approval flow uses keeps the scheduling rule narrow: AIs only
  // act when (a) a human asked them to, or (b) a human approved a
  // pending request.
  if (!user.isAI) {
    void wakeMentionedAIs(message.content).catch(() => {
      // Mention resolution failures are non-fatal; the message has
      // already been persisted + broadcast. Worst case: the AI
      // doesn't get its instant wakeup and runs on the next tick (or
      // never, when AI_AUTO_TICK is off — the user can re-prompt).
    });
  }

  return message;
}

/**
 * Match every `@<name>` token in a free-form message. The trailing
 * boundary class accepts ASCII letters, digits, underscore, and CJK
 * characters so a Chinese name like `@艾达` is still picked up.
 *
 * Captures group 1 holds the bare name (no leading `@`).
 */
const MENTION_REGEX = /@([\w\u4e00-\u9fff]+)/g;

/**
 * Common Chinese transliterations of each AI colleague's English
 * name. The browser-side translator (and humans) routinely render
 * `Ada` → `艾达 / 阿达` and `Hopper` → `霍珀 / 霍普 / 哈珀 / 哈柏`,
 * so a literal `name` comparison would miss those. We expand the
 * mention set with this table before matching against the database.
 *
 * Keys are lowercased English names that match `User.name` in the
 * seed; values are the alternate forms the wakeup matcher should
 * recognise. Lower-case the values too so the comparison stays
 * case-insensitive (CJK is unaffected by case-folding, but keeping
 * the codepath uniform avoids subtle Unicode bugs later).
 *
 * Custom AI colleagues created through the AI-colleague editor can
 * extend this set per-user via `aiSettings.mentionAliases`; see
 * {@link extractCustomMentionAliases}.
 */
const MENTION_ALIASES: Record<string, readonly string[]> = {
  ada: ['艾达', '阿达', 'ada'],
  hopper: ['霍珀', '霍普', '哈珀', '哈柏', 'hopper'],
};

/**
 * Read `User.aiSettings.mentionAliases` and return the cleaned list
 * of additional aliases this AI should respond to. Used in addition
 * to {@link MENTION_ALIASES} and the AI's literal `User.name`, so
 * custom AIs created via the AI-colleague editor can be summoned by
 * Chinese aliases / nicknames without code changes.
 *
 * Validates: closes audit finding H1 ("custom AIs cannot be
 * @-mentioned with non-English names").
 */
function extractCustomMentionAliases(aiSettings: unknown): readonly string[] {
  if (
    aiSettings === null ||
    aiSettings === undefined ||
    typeof aiSettings !== 'object' ||
    Array.isArray(aiSettings)
  ) {
    return [];
  }
  const raw = (aiSettings as Record<string, unknown>).mentionAliases;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/**
 * Extract every `@`-prefixed name from `content` and emit a `wakeup`
 * for each AI user whose `name` (or any alias in
 * {@link MENTION_ALIASES}) matches. Comparison is case-insensitive
 * and tolerates leading / trailing whitespace.
 *
 * Lookup happens in a single `prisma.user.findMany` so a message that
 * mentions both `@Ada` and `@Hopper` only costs one query. AI users
 * whose `name` does not appear in the message are silently ignored.
 *
 * Errors are bubbled up so the caller can decide whether to log;
 * `MessageService.create` swallows them (see comment above).
 */
async function wakeMentionedAIs(content: string): Promise<void> {
  const mentions = new Set<string>();
  for (const match of content.matchAll(MENTION_REGEX)) {
    mentions.add(match[1].trim().toLowerCase());
  }
  if (mentions.size === 0) return;

  const aiUsers = await prisma.user.findMany({
    where: { isAI: true, aiStatus: 'active' },
    select: { id: true, name: true, aiSettings: true },
  });

  for (const ai of aiUsers) {
    const englishName = ai.name.trim().toLowerCase();
    const baseAliases = MENTION_ALIASES[englishName] ?? [englishName];
    const customAliases = extractCustomMentionAliases(ai.aiSettings);
    const aliases = new Set<string>([...baseAliases, ...customAliases, englishName]);
    const matched = Array.from(aliases).some((alias) => mentions.has(alias));
    if (matched) {
      // Diagnostic: emitter singletons can drift when imported from
      // different bundle realms (next build worker vs custom server),
      // so log every emit so we can correlate with the listener side.
      logger.info(
        {
          event: 'mention_wakeup_emit',
          aiUserId: ai.id,
          aiName: ai.name,
          listenerCount: agenticEmitter.listenerCount('wakeup'),
        },
        'Mention wakeup emitted',
      );
      agenticEmitter.emit('wakeup', ai.id);
    }
  }
}

/**
 * Return every message in the given channel, ordered by `createdAt`
 * ascending (oldest first). Matches the natural reading order in the
 * UI. Kept as an independent implementation (rather than delegating to
 * `ChannelService.getMessages`) so message-specific concerns — e.g.
 * future filtering by sender or metadata — can be added here without
 * touching the channel service.
 *
 * Validates: Requirements 2.2.
 *
 * @param channelId - The channel whose messages should be returned.
 * @returns Messages of `channelId` ordered oldest-first. Returns an
 *   empty array when the channel has no messages (or does not exist).
 *
 * @example
 * ```ts
 * const history = await MessageService.listByChannel(channelId);
 * ```
 */
export async function listByChannel(channelId: string): Promise<Message[]> {
  return prisma.message.findMany({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Aggregated namespace export so callers can use either named imports
 * or the `MessageService.method(...)` style favored across the spec.
 */
export const MessageService = {
  create,
  listByChannel,
} as const;
