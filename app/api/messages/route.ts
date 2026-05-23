/**
 * `/api/messages` route handlers.
 *
 * Implements two operations on a single endpoint:
 *
 *   - `POST /api/messages` — persist a new channel message on behalf of
 *     the authenticated user and let the service layer broadcast
 *     `message:new` over Socket.io.
 *   - `GET  /api/messages?channelId=...` — return the message history
 *     for a single channel, ordered by `createdAt` ascending. Used by
 *     the channel page (task 3.9) to hydrate its initial timeline
 *     before realtime events take over.
 *
 * Common rules (both verbs):
 *   - Auth: requires a valid NextAuth session via `getServerSession`.
 *     Missing session ⇒ `401 { error }`. We resolve the session
 *     **before** parsing any input so unauthenticated callers cannot
 *     probe payload validation.
 *   - The realtime broadcast for `POST` is NOT performed here —
 *     `MessageService.create` owns it and only emits after the
 *     database write commits (Requirements 8.4 / 10.4 and
 *     `lib/services/message.service.ts`).
 *
 * `POST` contract:
 *   - Method: `POST`
 *   - Request body (JSON, validated by a zod schema):
 *     ```ts
 *     {
 *       channelId: string;            // non-empty cuid
 *       content:   string;            // non-blank, ≤ 8000 chars (service layer)
 *       metadata?: Record<string, unknown>;
 *     }
 *     ```
 *   - Responses:
 *     - `201 Message` on success — the persisted Prisma row, JSON-encoded.
 *     - `400 { error }` for malformed JSON, zod validation failures, or
 *       {@link ValidationError} surfaced by `MessageService.create`
 *       (empty / over-length content).
 *     - `401 { error }` when the request has no NextAuth session.
 *     - `500 { error }` for unexpected persistence failures.
 *
 * `GET` contract:
 *   - Method: `GET`
 *   - Query string: `channelId` (required, non-empty).
 *   - Responses:
 *     - `200 Message[]` on success (oldest-first; empty array when the
 *       channel has no messages or does not exist — matches
 *       `MessageService.listByChannel` semantics).
 *     - `400 { error }` when `channelId` is missing or empty.
 *     - `401 { error }` when the request has no NextAuth session.
 *     - `500 { error }` for unexpected persistence failures.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 4.4.
 *
 * @module app/api/messages/route
 */

import type { Message, Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authOptions } from '@/lib/auth/options';
import {
  MessageService,
  ValidationError,
} from '@/lib/services/message.service';

/** Always run this route on the Node.js runtime (Prisma needs Node APIs). */
export const runtime = 'nodejs';
/** Disable static optimization — both verbs are session-bound. */
export const dynamic = 'force-dynamic';

/**
 * Error envelope returned for every non-2xx response. Matches the
 * sibling `/api/channels` and `/api/tasks` routes so clients can treat
 * `{ error: string }` as the universal API error contract.
 */
interface ApiErrorResponse {
  error: string;
}

/**
 * Zod schema for the `POST /api/messages` request body.
 *
 * Transport-level validation only: shape, types, and "non-empty
 * channelId / content is a string". Deeper semantics (non-blank
 * content, ≤ 8000 chars) are still enforced by
 * {@link MessageService.create} so the AI tool surface and HTTP surface
 * share a single source of truth. `metadata` is restricted to a JSON
 * object (or omitted) to align with the realtime payload contract,
 * which only forwards object-shaped metadata.
 */
const createMessageBodySchema = z
  .object({
    channelId: z.string().min(1, 'Field "channelId" must be a non-empty string.'),
    content: z.string({
      required_error: 'Field "content" is required.',
      invalid_type_error: 'Field "content" must be a string.',
    }),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Inferred TypeScript type of the validated request body. Kept private
 * to this module — callers should rely on the route's HTTP contract
 * rather than importing the body shape.
 */
type CreateMessageRequestBody = z.infer<typeof createMessageBodySchema>;

/**
 * Format a {@link z.ZodError} into a single human-readable string. We
 * surface the first issue's path + message so clients see an
 * actionable description without having to parse a structured error
 * envelope.
 */
function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid request body.';
  const path = issue.path.length > 0 ? issue.path.join('.') : '(body)';
  return `${path}: ${issue.message}`;
}

/**
 * Handle `POST /api/messages`. See module docs for the full contract.
 *
 * Steps:
 *   1. Resolve the NextAuth session; reject with `401` if absent.
 *   2. Parse the request body as JSON, returning `400` on syntax errors.
 *   3. Validate the parsed body against {@link createMessageBodySchema},
 *      returning `400` on shape / type errors.
 *   4. Delegate to {@link MessageService.create}, which performs the
 *      domain-level checks (non-blank, length cap), persists the row,
 *      and emits `message:new` after a successful commit.
 *   5. Translate {@link ValidationError} to `400`; any other error to
 *      `500`. The realtime layer is not invoked when persistence fails.
 */
export async function POST(
  request: Request,
): Promise<NextResponse<Message | ApiErrorResponse>> {
  // 1. Auth gate.
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  // 2. Parse JSON body. Malformed JSON → 400 with a clear hint.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  // 3. Schema-validate the body. Shape / type failures → 400.
  const parsed = createMessageBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json<ApiErrorResponse>(
      { error: formatZodError(parsed.error) },
      { status: 400 },
    );
  }
  const body: CreateMessageRequestBody = parsed.data;

  // 4. Delegate to the service layer. ValidationError → 400; any
  //    other error is treated as an internal failure (no realtime
  //    broadcast has occurred because the service emits only after a
  //    successful commit — see lib/services/message.service.ts).
  try {
    const message = await MessageService.create({
      channelId: body.channelId,
      userId: session.user.id,
      content: body.content,
      ...(body.metadata !== undefined
        ? {
            // The zod schema already proved this is a non-null,
            // non-array plain object. Cast to Prisma's accepted JSON
            // input shape — `Record<string, unknown>` is structurally
            // narrower than `InputJsonObject` only because of TS's
            // index signature rules.
            metadata: body.metadata as Prisma.InputJsonValue,
          }
        : {}),
    });
    return NextResponse.json<Message>(message, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json<ApiErrorResponse>(
        { error: err.message },
        { status: 400 },
      );
    }
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to create message.' },
      { status: 500 },
    );
  }
}

/**
 * Handle `GET /api/messages?channelId=...`. Returns the channel's
 * message history in `createdAt` ascending order via
 * {@link MessageService.listByChannel}.
 *
 * Mirrors the auth + error-handling shape of `POST` so clients can
 * rely on the same `{ error: string }` envelope across both verbs.
 */
export async function GET(
  request: Request,
): Promise<NextResponse<Message[] | ApiErrorResponse>> {
  // 1. Auth gate.
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  // 2. Validate the `channelId` query param.
  const channelId = new URL(request.url).searchParams.get('channelId');
  if (channelId === null || channelId.length === 0) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Query parameter "channelId" must be a non-empty string.' },
      { status: 400 },
    );
  }

  // 3. Delegate to the service layer. We deliberately use
  //    `MessageService.listByChannel` (rather than `ChannelService`)
  //    so message-specific concerns can evolve without touching the
  //    channel service.
  try {
    const messages = await MessageService.listByChannel(channelId);
    return NextResponse.json<Message[]>(messages, { status: 200 });
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to load messages.' },
      { status: 500 },
    );
  }
}
