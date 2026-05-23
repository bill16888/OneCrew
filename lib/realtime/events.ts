/**
 * Realtime event constants and payload type definitions for Socket.io.
 *
 * These are the four events emitted by the server to clients:
 *   - message:new       → a new chat message was persisted in a channel
 *   - task:updated      → a task snapshot was created or updated
 *   - ai:thinking       → an AI colleague started or stopped thinking
 *   - approval:created  → a new approval request was created (PENDING)
 *
 * This module is intentionally decoupled from Prisma-generated types so that
 * `lib/realtime/*` can be imported in environments where the Prisma client is
 * not available (e.g. browser bundles). Field names are kept aligned with
 * `prisma/schema.prisma`; status values are typed as string-literal unions
 * matching the corresponding Prisma enums (kept separate from EVENTS so the
 * two surfaces evolve independently but stay paired through this module).
 *
 * Reference: design.md → "Realtime (Socket.io + NextAuth 会话校验)" → "事件类型"
 *
 * Validates: Requirements 8.1
 */

/**
 * The four realtime event names. Frozen as a `const` object so consumers may
 * import either the keys (`EVENTS.MessageNew`) or the underlying string
 * literals via the `EventName` union below.
 */
export const EVENTS = {
  /** Emitted to `channel:{channelId}` after a Message is persisted. */
  MessageNew: 'message:new',
  /** Emitted to `workspace:{WORKSPACE_ID}` after a Task is created/updated. */
  TaskUpdated: 'task:updated',
  /** Emitted to `workspace:{WORKSPACE_ID}` when an AI cycle starts/ends. */
  AIThinking: 'ai:thinking',
  /** Emitted to `workspace:{WORKSPACE_ID}` after an Approval is created. */
  ApprovalCreated: 'approval:created',
} as const;

/** Union of all realtime event name string literals. */
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Task status values, mirrors the Prisma `TaskStatus` enum. */
export type TaskStatusName = 'Backlog' | 'InProgress' | 'InReview' | 'Done';

/** Approval status values, mirrors the Prisma `ApprovalStatus` enum. */
export type ApprovalStatusName = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * Payload broadcast on `message:new`.
 *
 * Triggered when {@link EVENTS.MessageNew} is emitted by `MessageService.create`
 * after a `Message` row is persisted. Mirrors the stored row plus a derived
 * `fromAI` flag indicating whether the sender is an AI colleague
 * (i.e. `User.isAI === true`).
 */
export interface MessageNewPayload {
  /** Internal cuid primary key of the Message row. */
  id: string;
  channelId: string;
  /** Sender user id (human or AI colleague). */
  userId: string;
  content: string;
  /** Structured JSON metadata (tool calls, referenced tasks, …) or `null`. */
  metadata: Record<string, unknown> | null;
  /** ISO 8601 timestamp string (Date is serialized to string over the wire). */
  createdAt: string;
  /** True iff the sender is an AI colleague. */
  fromAI: boolean;
}

/**
 * Payload broadcast on `task:updated`.
 *
 * Triggered when {@link EVENTS.TaskUpdated} is emitted by `TaskService.create`
 * or `TaskService.updateStatus` after a successful persistence. The payload
 * is a complete Task snapshot — both creation and status updates emit this
 * event with the latest persisted state.
 */
export interface TaskUpdatedPayload {
  /** Internal cuid primary key. */
  id: string;
  /** Human-readable task id, format `PROJ-{N}`. */
  taskId: string;
  title: string;
  /** Optional task description; `null` when unset. */
  description: string | null;
  status: TaskStatusName;
  isAITask: boolean;
  creatorId: string;
  /** Optional assignee; `null` when the task is unassigned. */
  assigneeId: string | null;
  /** ISO 8601 timestamp string. */
  createdAt: string;
  /** ISO 8601 timestamp string. */
  updatedAt: string;
}

/**
 * Payload broadcast on `ai:thinking`.
 *
 * Triggered at the start of `AIRuntime.runCycle` (`state: true`) and again
 * in the cycle's `finally` block (`state: false`), regardless of finishReason.
 * Used by the UI to render thinking indicators next to AI avatars.
 */
export interface AIThinkingPayload {
  aiUserId: string;
  state: boolean;
}

/**
 * Payload broadcast on `approval:created`.
 *
 * Triggered when {@link EVENTS.ApprovalCreated} is emitted by
 * `ApprovalService.create` after the AI invokes the `request_approval` tool.
 * At creation time `status` is always `PENDING`; subsequent state transitions
 * (`APPROVED` / `REJECTED`) are not delivered through this event.
 */
export interface ApprovalCreatedPayload {
  /** Internal cuid primary key. */
  id: string;
  /** The AI colleague that requested the approval. */
  aiUserId: string;
  /** The action being requested, e.g. `create_task` or `send_channel_message`. */
  action: string;
  /** Structured JSON payload describing the requested action, or `null`. */
  payload: Record<string, unknown> | null;
  status: ApprovalStatusName;
  /** ISO 8601 timestamp string. */
  createdAt: string;
}

/**
 * Mapping from event name to its payload type. Useful for typed `emit` /
 * `on` helpers in the Socket.io layer.
 */
export interface EventPayloads {
  [EVENTS.MessageNew]: MessageNewPayload;
  [EVENTS.TaskUpdated]: TaskUpdatedPayload;
  [EVENTS.AIThinking]: AIThinkingPayload;
  [EVENTS.ApprovalCreated]: ApprovalCreatedPayload;
}

/**
 * Server → client event signatures, suitable for
 * `Server<ListenEvents, EmitEvents>` from `socket.io`. Each property is a
 * listener signature receiving the payload; emitters infer payload types
 * from this map. These four are the only events the server emits.
 */
export interface ServerToClientEvents {
  [EVENTS.MessageNew]: (payload: MessageNewPayload) => void;
  [EVENTS.TaskUpdated]: (payload: TaskUpdatedPayload) => void;
  [EVENTS.AIThinking]: (payload: AIThinkingPayload) => void;
  [EVENTS.ApprovalCreated]: (payload: ApprovalCreatedPayload) => void;
}

/**
 * Client → server event signatures. Currently a single channel-room
 * subscription event used by `lib/realtime/io.ts` to join `channel:{id}`
 * rooms (see design.md → "Realtime" → "会话校验中间件").
 */
export interface ClientToServerEvents {
  'subscribe:channel': (channelId: string) => void;
}

/**
 * Server ↔ server event signatures. Reserved for future cross-instance
 * coordination (Socket.io adapter / cluster); empty for the single-process
 * MVP but declared so the typed server signature stays explicit.
 */
export interface InterServerEvents {
  // intentionally empty in the MVP
}

/**
 * Per-socket application data attached during the handshake auth
 * middleware in `lib/realtime/io.ts`. Set by the NextAuth session check
 * and read by connection / event handlers (and by future broadcast paths
 * that need to know which user is connected).
 *
 * Validates: Requirements 8.2, 8.3
 */
export interface SocketData {
  /**
   * Persistent database user id (cuid) of the authenticated user,
   * sourced from the NextAuth JWT (`token.uid`, falling back to
   * `token.sub`). Optional only because Socket.io initializes
   * `socket.data` to an empty object before middleware runs; once the
   * auth middleware succeeds it is always populated, and any handshake
   * that fails to populate it is rejected with `'unauthenticated'`.
   */
  userId?: string;
}
