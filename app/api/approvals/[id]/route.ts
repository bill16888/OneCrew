/**
 * `PATCH /api/approvals/[id]` route handler.
 *
 * Endpoint used by the {@link ApprovalDialog} (task 9.5) to record a
 * human decision on a `PENDING` approval. Wraps two service-layer
 * primitives:
 *
 *   - `decision: 'approve'` ⇒ {@link ApprovalService.approve} —
 *     transitions the row `PENDING → APPROVED` and emits `wakeup` on
 *     the {@link agenticEmitter} so the requesting AI colleague can
 *     resume its decision cycle without waiting for the next 30 s tick
 *     (Requirements 6.3, 6.6).
 *   - `decision: 'reject'` ⇒ {@link ApprovalService.reject} —
 *     transitions the row `PENDING → REJECTED` and emits `reject` on
 *     the {@link agenticEmitter} so the AI Runtime aborts its in-flight
 *     cycle. **No `wakeup` is emitted** on rejection (Requirements 6.4).
 *
 * The realtime side-effects above happen inside the service layer; this
 * route is a thin HTTP adapter and does not interact with Socket.io
 * directly.
 *
 * Contract:
 *   - Method: `PATCH`
 *   - Path param: `id` — the `Approval.id` (cuid).
 *   - Auth: requires a valid NextAuth session via `getServerSession`.
 *     Missing session ⇒ `401 { error }`. The session's `user.id` is
 *     forwarded to the service layer as `decidedById` for audit.
 *   - Request body (JSON, validated by zod):
 *     ```ts
 *     { decision: 'approve' | 'reject' }
 *     ```
 *   - Responses:
 *     - `200 Approval` — the updated Prisma row; `Date` fields are
 *       serialized to ISO 8601 strings by `NextResponse.json`.
 *     - `400 { error }` — malformed JSON or zod validation failure.
 *     - `401 { error }` — request has no NextAuth session.
 *     - `404 { error }` — Prisma `P2025` (record not found / no row to
 *       update).
 *     - `500 { error }` — any other unexpected persistence failure.
 *
 * Validates: Requirements 6.3, 6.4.
 *
 * @module app/api/approvals/[id]/route
 */

import type { Approval } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authOptions } from '@/lib/auth/options';
import { ApprovalService } from '@/lib/services/approval.service';

/** Always run this route on the Node.js runtime (Prisma needs Node APIs). */
export const runtime = 'nodejs';
/** Disable static optimization — every request is session-bound. */
export const dynamic = 'force-dynamic';

/**
 * Error envelope returned for every non-2xx response. Matches the
 * sibling `/api/messages` and `/api/tasks` routes so clients can rely
 * on a single `{ error: string }` contract across the API surface.
 */
interface ApiErrorResponse {
  error: string;
}

/**
 * Path-parameter shape injected by Next.js App Router for dynamic
 * segments declared as `[id]`. Kept private to this module because the
 * router owns its construction.
 */
interface RouteContext {
  params: { id: string };
}

/**
 * Zod schema for the `PATCH /api/approvals/[id]` request body.
 *
 * Only the discriminator field `decision` is accepted; all other keys
 * are rejected via `.strict()` so future client-side typos surface as
 * `400` rather than being silently ignored.
 */
const decisionBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject'], {
      required_error: 'Field "decision" is required.',
      invalid_type_error: 'Field "decision" must be "approve" or "reject".',
    }),
  })
  .strict();

/**
 * Inferred type of the validated request body. Local to this module so
 * callers depend on the HTTP contract, not the parser.
 */
type DecisionBody = z.infer<typeof decisionBodySchema>;

/**
 * Format a {@link z.ZodError} into a single human-readable string,
 * mirroring the helper used by `app/api/messages/route.ts` so error
 * shapes stay consistent across endpoints.
 */
function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid request body.';
  const path = issue.path.length > 0 ? issue.path.join('.') : '(body)';
  return `${path}: ${issue.message}`;
}

/**
 * Type guard for Prisma's "record not found" error
 * ({@link Prisma.PrismaClientKnownRequestError} with `code === 'P2025'`).
 *
 * Prisma raises `P2025` when an `update` or `delete` targets a row that
 * does not exist. We translate it to HTTP `404` so clients can
 * distinguish "this approval id is unknown" from a generic `500`.
 */
function isPrismaNotFoundError(
  err: unknown,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025'
  );
}

/**
 * Handle `PATCH /api/approvals/[id]`. See module docs for the full
 * contract.
 *
 * Steps:
 *   1. Resolve the NextAuth session; reject with `401` if absent. We do
 *      this before parsing the body so unauthenticated callers cannot
 *      probe payload validation.
 *   2. Parse the JSON body, returning `400` on syntax errors.
 *   3. Validate the body against {@link decisionBodySchema}, returning
 *      `400` on shape / enum failures.
 *   4. Dispatch to {@link ApprovalService.approve} or
 *      {@link ApprovalService.reject} depending on `decision`. The
 *      service layer owns the realtime side-effects (emitting `wakeup`
 *      / `reject` on the agentic emitter) and only fires them after a
 *      successful database commit.
 *   5. Translate Prisma `P2025` to `404`; any other error to `500`.
 *      The service layer has already guaranteed that no
 *      `wakeup` / `reject` event is emitted when persistence fails, so
 *      we don't need to roll anything back here.
 */
export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse<Approval | ApiErrorResponse>> {
  // 1. Auth gate. Without a session we refuse to disclose anything
  //    about the approval (existence or shape).
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }
  const decidedById = session.user.id;

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

  // 3. Schema-validate the body. Shape / enum failures → 400.
  const parsed = decisionBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json<ApiErrorResponse>(
      { error: formatZodError(parsed.error) },
      { status: 400 },
    );
  }
  const body: DecisionBody = parsed.data;

  // 4. Delegate to the service layer. Each branch transitions the row
  //    and — on a successful commit — emits the matching event on the
  //    agentic emitter (`wakeup` for approve, `reject` for reject).
  try {
    const approval =
      body.decision === 'approve'
        ? await ApprovalService.approve(params.id, decidedById)
        : await ApprovalService.reject(params.id, decidedById);
    return NextResponse.json<Approval>(approval, { status: 200 });
  } catch (err) {
    // 5a. Prisma "record not found" → 404 so the client can surface
    //     a distinct "this approval no longer exists" message.
    if (isPrismaNotFoundError(err)) {
      return NextResponse.json<ApiErrorResponse>(
        { error: `Approval "${params.id}" not found.` },
        { status: 404 },
      );
    }
    // 5b. Anything else is treated as an internal failure. The
    //     service layer guarantees no realtime event has been emitted
    //     when persistence fails (see lib/services/approval.service.ts).
    return NextResponse.json<ApiErrorResponse>(
      { error: 'Failed to update approval.' },
      { status: 500 },
    );
  }
}
