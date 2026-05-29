/**
 * @file AI runtime: multi-round `tool_use` cycle for a single AI colleague.
 *
 * `runCycle(aiUserId)` is the entry point the Agentic Loop calls on every
 * 30 s tick (and on `wakeup` events from the approval flow). It is the
 * **only** place the codebase issues model calls (DeepSeek via the
 * OpenAI-compatible chat completions endpoint, see
 * `lib/ai/anthropic.ts`), which keeps three invariants centralised:
 *
 *   - **Role-keyed system prompt** (Property 11): every Anthropic call
 *     issued for an AI colleague with `aiRole = r` carries
 *     `system === SYSTEM_PROMPTS[r]`.
 *   - **Closed tool surface** (Property 12): every Anthropic call passes
 *     the same 6-tool set defined in {@link TOOL_DEFINITIONS}.
 *   - **Bounded autonomy**:
 *       - At most {@link MAX_ROUNDS} `tool_use` rounds per cycle
 *         (Property 22 — Requirements 7.3, 7.4).
 *       - At most `1 + MAX_RETRIES = 4` Anthropic attempts per round, via
 *         {@link callAnthropicWithRetry} (Property 28 — Requirements 10.1,
 *         10.2).
 *
 * Realtime contract (Property 24 — Requirements 7.6, 7.7):
 * exactly one `ai:thinking { aiUserId, state: true }` is broadcast at the
 * start of the cycle and exactly one `ai:thinking { aiUserId, state: false }`
 * at the end (in `finally`), regardless of which `finishReason` we land on.
 *
 * Termination — `RunCycleResult.finishReason`:
 *   - `'stop'`             — the model returned a non-`tool_use` stop reason
 *                            (`end_turn`, `max_tokens`, `stop_sequence`, …).
 *   - `'round_cap'`        — every round up to {@link MAX_ROUNDS} returned
 *                            `tool_use`, so the runtime stopped on the cap.
 *   - `'retry_exhausted'`  — {@link callAnthropicWithRetry} re-threw after
 *                            exhausting its bounded retry budget.
 *   - `'rejected'`         — reserved for the approval-rejection path
 *                            wired in task 9.x (Property 20). Declared on
 *                            the union so call sites can already pattern-
 *                            match on it without an `as` cast.
 *
 * After the cycle ends a single structured log line carries `aiUserId`,
 * `rounds`, `finishReason`, `durationMs` (Requirement 10.5). Logging
 * goes through the shared pino instance in `lib/logger.ts`, so the
 * cycle summary participates in the same structured stream as service-
 * layer errors and Agentic Loop tick failures.
 *
 * Validates: Requirements 4.2, 5.9, 7.3, 7.4, 7.6, 7.7, 10.5
 */

import * as Sentry from '@sentry/nextjs';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { EVENTS } from '@/lib/realtime/events';
import { getIO } from '@/lib/realtime/io';
import { markThinking } from '@/lib/realtime/thinking';
import { ChannelService } from '@/lib/services/channel.service';
import { MessageService } from '@/lib/services/message.service';
import { resolveWorkspaceId } from '@/lib/workspace';

import { MODEL, callAnthropicWithRetry } from './anthropic';
import { BUDGET_EXCEEDED_CODE, budget } from './budget';
import { trimContextToTokenBudget } from './context';
import {
  type AnthropicLikeMessage,
  type AnthropicLikeMessageParam as MessageParam,
  type AnthropicLikeTool as Tool,
  type AnthropicLikeToolResultBlock as ToolResultBlockParam,
  type AnthropicLikeToolUseBlock as ToolUseBlock,
} from './openai-bridge';
import { SYSTEM_PROMPTS } from './prompts';
import { dispatchTool, TOOL_DEFINITIONS, type ToolCall } from './tools';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of `tool_use` rounds executed per call to {@link runCycle}.
 *
 * The runtime issues at most this many model requests for a single cycle.
 * When every one of those rounds returns `stop_reason === 'tool_use'`,
 * the cycle terminates with
 * `finishReason = 'round_cap'` (Property 22 — Requirements 7.3, 7.4).
 */
export const MAX_ROUNDS = 5;

/**
 * Token budget passed to {@link trimContextToTokenBudget} on every round.
 * The Anthropic system prompt is sent as the dedicated `system` parameter
 * and is **not** counted against this budget — only the rolling
 * `messages` transcript is. 100k leaves comfortable headroom under the
 * Sonnet 200k context window for the tools section, response output, and
 * the system prompt itself (Requirement 7.5).
 */
const CONTEXT_TOKEN_BUDGET = 100_000;

/**
 * Maximum tokens the model may emit per round. Bounded so a single
 * round cannot blow past DeepSeek's billing limits or block the cycle
 * for an unreasonably long time.
 */
const MAX_OUTPUT_TOKENS = 1024;

/**
 * The DeepSeek model identifier and the OpenAI-compatible endpoint
 * are configured in `lib/ai/anthropic.ts` (the file kept its original
 * name to avoid churn across imports + tests). The runtime simply
 * forwards the imported {@link MODEL} on every call so swapping
 * models requires only one env-var change.
 */

/**
 * Lookback window for the channel digest injected as the cycle's
 * initial user message: the runtime considers messages created within
 * the last `RECENT_MESSAGE_LOOKBACK_MS` ms.
 */
const RECENT_MESSAGE_LOOKBACK_MS = 5 * 60 * 1000;

/**
 * Hard cap on how many recent messages are injected into the digest.
 * Keeps the initial context bounded even on busy channels.
 */
const RECENT_MESSAGE_LIMIT = 50;

function asRecord(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return {};
}

function getCustomSystemPrompt(aiSettings: unknown): string | null {
  const candidate = asRecord(aiSettings).systemPrompt;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read a per-AI tool whitelist out of `User.aiSettings.toolSet`.
 *
 * Returns `undefined` (i.e. "no whitelist; allow the full surface")
 * when the field is missing, not an array, or empty after filtering
 * out non-string entries. The dispatcher treats `undefined` and `[]`
 * identically — only a non-empty array activates the per-AI guard.
 *
 * Validates: closes audit finding C4 ("toolSet stored but never
 * enforced") by giving the runtime a single, defensive read of the
 * config the AI-colleague editor persists.
 */
function getAllowedTools(aiSettings: unknown): readonly string[] | undefined {
  const candidate = asRecord(aiSettings).toolSet;
  if (!Array.isArray(candidate)) return undefined;
  const cleaned = candidate.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

function getRoleSystemPrompt(aiRole: string | null): string | null {
  if (aiRole === 'Ada' || aiRole === 'Hopper') {
    return SYSTEM_PROMPTS[aiRole];
  }
  return null;
}

function buildGenericSystemPrompt(aiName: string): string {
  return [
    `You are ${aiName}, an AI teammate in AI-Native Team Workspace.`,
    'Collaborate with human teammates through channels, tasks, and approvals.',
    'Always write user-facing messages in Simplified Chinese.',
    'For production changes, external communication, destructive actions, or other high-risk work, call request_approval before taking action.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a {@link runCycle} call ended.
 *
 * - `'stop'`            — the model returned `stop_reason !== 'tool_use'`.
 * - `'round_cap'`       — every round up to {@link MAX_ROUNDS} returned
 *                         `'tool_use'` and the runtime stopped on the cap.
 * - `'retry_exhausted'` — {@link callAnthropicWithRetry} re-threw after
 *                         exhausting its bounded retry budget.
 * - `'rejected'`        — reserved for the approval-rejection wiring
 *                         landing in task 9.x (Property 20).
 * - `'budget_exceeded'` — the daily AI USD budget tripped its circuit
 *                         breaker mid-cycle. The cycle posts a system
 *                         notice in `#general` and stops without
 *                         issuing further Anthropic calls.
 */
export type FinishReason =
  | 'stop'
  | 'round_cap'
  | 'retry_exhausted'
  | 'rejected'
  | 'budget_exceeded';

/**
 * Result returned by every {@link runCycle} invocation. Also the shape
 * logged at info level when the cycle ends (Requirement 10.5).
 */
export interface RunCycleResult {
  /** `User.id` of the AI colleague this cycle ran for. */
  readonly aiUserId: string;
  /** Number of model calls actually issued this cycle (1..MAX_ROUNDS). */
  readonly rounds: number;
  /** Why the cycle stopped — see {@link FinishReason}. */
  readonly finishReason: FinishReason;
  /** Wall-clock duration from cycle start to cycle end, in ms. */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Realtime helper: ai:thinking
// ---------------------------------------------------------------------------

/**
 * Broadcast `ai:thinking { aiUserId, state }` to the workspace room.
 *
 * No-ops when the Socket.io server has not been initialized yet (e.g.
 * during unit tests or before `server.ts` wires the realtime layer).
 * The runtime is responsible for emitting **exactly one** `state: true`
 * before the loop starts and **exactly one** `state: false` in `finally`,
 * to satisfy Property 24 (Requirements 7.6, 7.7).
 */
function emitThinking(aiUserId: string, state: boolean): void {
  // Keep the process-local snapshot in lock-step with the broadcast so
  // the dashboard (Phase 1 Req 13.2) can read current thinking state at
  // page-load time, before any socket event arrives. This runs even
  // when no IO server is wired (tests), which is harmless.
  markThinking(aiUserId, state);

  const io = getIO();
  if (!io) return;
  const room = `workspace:${resolveWorkspaceId()}`;
  io.to(room).emit(EVENTS.AIThinking, { aiUserId, state });
}

// ---------------------------------------------------------------------------
// Initial context builder
// ---------------------------------------------------------------------------

/**
 * Assemble the very first `user` message handed to the model on round 1.
 *
 * Two slices of state are inlined so the model has fresh situational
 * awareness without relying on prior conversation memory:
 *
 *   1. **Recent channel digest** — every message persisted across the
 *      workspace within the last {@link RECENT_MESSAGE_LOOKBACK_MS} ms
 *      (capped at {@link RECENT_MESSAGE_LIMIT} entries, oldest first so
 *      the model reads them in the same order a human would).
 *   2. **In-progress task summary** — every {@link Task} row whose
 *      `status === 'InProgress'`, listed by `taskId`, title, and
 *      assignee.
 *
 * Both sections are rendered as plain text under fixed headings so the
 * digest stays predictable regardless of whether either query returns
 * zero rows; in that case an explicit `(no …)` placeholder is emitted
 * instead of an empty bullet list.
 *
 * @param workspaceId The active workspace id (already resolved by the
 *   caller — passed in to keep this helper free of `process.env` reads).
 * @returns A one-element `MessageParam[]` representing the seeded
 *   conversation. Returning the array (rather than a bare string) lets
 *   the caller append rounds without restructuring the value.
 */
async function buildInitialContext(
  workspaceId: string,
  extraInstruction?: string,
): Promise<MessageParam[]> {
  const lookbackStart = new Date(Date.now() - RECENT_MESSAGE_LOOKBACK_MS);

  // The three reads are independent and pure (read-only); fire them in
  // parallel so the cycle's startup latency is bounded by the slowest
  // of the queries rather than their sum.
  const [recentMessages, inProgressTasks, allChannels] = await Promise.all([
    prisma.message.findMany({
      where: {
        createdAt: { gte: lookbackStart },
        channel: { workspaceId },
      },
      orderBy: { createdAt: 'asc' },
      take: RECENT_MESSAGE_LIMIT,
      include: {
        user: { select: { name: true, isAI: true } },
        channel: { select: { name: true } },
      },
    }),
    prisma.task.findMany({
      where: { workspaceId, status: 'InProgress' },
      orderBy: { createdAt: 'asc' },
      include: { assignee: { select: { name: true } } },
    }),
    // Pulling every channel in the workspace is cheap (the MVP keeps
    // the channel set tiny) and lets us inject a *concrete* channel
    // directory into the initial prompt so the model never has to
    // guess `channelId` arguments for `send_channel_message`. Without
    // this, the AI invented IDs like `general` (instead of the seeded
    // `chan_general`), tripping the `Message_channelId_fkey` FK.
    prisma.channel.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  const messageDigest =
    recentMessages.length === 0
      ? '(no channel messages in the last 5 minutes)'
      : recentMessages
          .map((m) => {
            const author = m.user.isAI ? `${m.user.name} [AI]` : m.user.name;
            return `[#${m.channel.name}] ${author}: ${m.content}`;
          })
          .join('\n');

  const taskDigest =
    inProgressTasks.length === 0
      ? '(no tasks currently in progress)'
      : inProgressTasks
          .map((t) => {
            const owner = t.assignee?.name ?? 'unassigned';
            return `- ${t.taskId} ${t.title} (assignee: ${owner})`;
          })
          .join('\n');

  // Channel directory: surface the canonical (id, name) pairs so the
  // model has a closed list to draw from when issuing
  // `send_channel_message({ channelId, ... })`. Empty workspaces fall
  // back to a clear placeholder so the prompt remains parseable.
  const channelDigest =
    allChannels.length === 0
      ? '(no channels exist yet)'
      : allChannels
          .map((c) => `- id="${c.id}" name="#${c.name}"`)
          .join('\n');

  const content =
    `Available channels (use the literal id when calling send_channel_message):\n${channelDigest}\n\n` +
    `Recent channel digest:\n${messageDigest}\n\n` +
    `In-progress tasks:\n${taskDigest}` +
    // Phase 1 Req 15: an optional caller-supplied instruction (e.g. the
    // end-of-day daily-report ask) is appended AFTER the situational
    // digest so the model has full context before acting on it.
    (extraInstruction ? `\n\n---\n${extraInstruction}` : '');

  return [{ role: 'user', content }];
}

// ---------------------------------------------------------------------------
// Tool surface helpers
// ---------------------------------------------------------------------------

/**
 * Cast {@link TOOL_DEFINITIONS} (a `readonly` literal-typed list) to the
 * mutable `Tool[]` array Anthropic's SDK expects on `messages.create`.
 *
 * Performed once per cycle (not once per round) so all rounds share the
 * exact same tool surface — Property 12 ("工具表面恒等",
 * Requirement 5.1) follows by construction.
 */
function asAnthropicTools(): Tool[] {
  return TOOL_DEFINITIONS as unknown as Tool[];
}

/**
 * Type guard narrowing a `ContentBlock` returned by the model to
 * {@link ToolUseBlock}. The Anthropic response can interleave `text`
 * and `tool_use` blocks; we dispatch only the latter.
 */
function isToolUseBlock(block: { type: string }): block is ToolUseBlock {
  return block.type === 'tool_use';
}

// ---------------------------------------------------------------------------
// runCycle
// ---------------------------------------------------------------------------

/**
 * Execute a single multi-round `tool_use` cycle on behalf of one AI
 * colleague.
 *
 * Lifecycle:
 *
 *   1. Look up the AI user (`prisma.user.findUniqueOrThrow`) and assert
 *      `isAI === true` and `aiRole ∈ {'Ada','Hopper'}`. A misconfigured
 *      user fails fast — no Anthropic call, no realtime emission.
 *   2. Broadcast `ai:thinking { state: true }` to the workspace room.
 *   3. Build the initial user message (channel digest + in-progress
 *      task summary) via {@link buildInitialContext}.
 *   4. Loop up to {@link MAX_ROUNDS} times:
 *        - Trim the rolling transcript to {@link CONTEXT_TOKEN_BUDGET}
 *          (oldest entries dropped first; system prompt is excluded).
 *        - Issue a non-streaming Anthropic request via
 *          {@link callAnthropicWithRetry} (bounded exponential backoff).
 *        - If `stop_reason !== 'tool_use'`, set `finishReason = 'stop'`
 *          and break.
 *        - Otherwise, extract every `tool_use` block and dispatch them
 *          through {@link dispatchTool} **in parallel** (the dispatcher
 *          is total — it never throws — so `Promise.all` is safe).
 *        - Append the assistant content and the resulting `tool_result`
 *          blocks to the transcript so the next round sees both. The
 *          `tool_result`s are paired 1:1 with the model's `tool_use`
 *          ids (Property 17 — Requirement 5.9).
 *   5. If the loop exhausted {@link MAX_ROUNDS} without breaking, set
 *      `finishReason = 'round_cap'` (Property 22).
 *   6. On any thrown error inside the loop (only possible from
 *      `callAnthropicWithRetry` after exhausting retries — `dispatchTool`
 *      cannot throw), set `finishReason = 'retry_exhausted'`.
 *   7. In `finally`, broadcast `ai:thinking { state: false }` exactly
 *      once and emit a structured info log carrying `aiUserId`,
 *      `rounds`, `finishReason`, `durationMs` (Requirement 10.5).
 *
 * Validates: Requirements 4.2, 5.9, 7.3, 7.4, 7.6, 7.7, 10.5.
 *
 * @param aiUserId `User.id` of the AI colleague to run. The user MUST
 *   have `isAI === true`.
 * @returns A {@link RunCycleResult} describing how the cycle ended.
 * @throws  When `aiUserId` does not resolve to a user, or that user is
 *   not an AI. These configuration errors are
 *   surfaced (rather than swallowed) so the Agentic Loop can log them
 *   distinctly from in-cycle failures.
 */
/**
 * Options accepted by {@link runCycle}.
 */
export interface RunCycleOptions {
  /**
   * An extra instruction appended to the initial context after the
   * recent-activity digest. Used by the daily-report scheduler
   * (`lib/reports/daily.ts`, Phase 1 Req 15) to ask the AI to produce
   * a structured report and post it via `send_channel_message`. When
   * omitted the cycle behaves exactly as the periodic/wakeup path.
   */
  readonly extraInstruction?: string;
}

export async function runCycle(
  aiUserId: string,
  options: RunCycleOptions = {},
): Promise<RunCycleResult> {
  const start = Date.now();

  // 1. Resolve the AI user and validate it. We do this *before*
  //    emitting `ai:thinking { true }` so a misconfigured user does
  //    not leave a lingering "thinking" indicator in the UI.
  const ai = await prisma.user.findUniqueOrThrow({
    where: { id: aiUserId },
  });

  if (!ai.isAI) {
    throw new Error(
      `runCycle called for non-AI user ${aiUserId} (User.isAI === false)`,
    );
  }
  const workspaceId = resolveWorkspaceId();
  const tools = asAnthropicTools();
  const system =
    getCustomSystemPrompt(ai.aiSettings) ??
    getRoleSystemPrompt(ai.aiRole) ??
    buildGenericSystemPrompt(ai.name);
  // Per-AI tool whitelist (audit C4). `undefined` preserves the legacy
  // full-surface behaviour for seeded Ada/Hopper roles; a non-empty
  // array constrains custom AIs to the operator-configured subset.
  const allowedTools = getAllowedTools(ai.aiSettings);

  let rounds = 0;
  let finishReason: FinishReason | null = null;

  // 2. Announce the cycle start to the workspace room. The matching
  //    `state: false` is emitted in `finally` exactly once.
  emitThinking(aiUserId, true);

  try {
    // 3. Seed the conversation with a digest of recent activity so the
    //    model has fresh context on round 1. A caller-supplied
    //    `extraInstruction` (daily report) is appended after the digest.
    const messages: MessageParam[] = await buildInitialContext(
      workspaceId,
      options.extraInstruction,
    );

    // 4. Multi-round tool_use loop. The cap is the loop guard itself —
    //    no manual decrement / break needed for the cap case.
    while (rounds < MAX_ROUNDS) {
      rounds++;

      // Trim before each call so a long-running cycle never breaches
      // the context budget. The system prompt is sent separately.
      const trimmed = trimContextToTokenBudget(messages, CONTEXT_TOKEN_BUDGET);

      const response: AnthropicLikeMessage = await callAnthropicWithRetry({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools,
        messages: trimmed,
      });

      // Track the call's estimated USD cost against the daily budget.
      // `track` throws `Error('AI_BUDGET_EXCEEDED')` when today's tally
      // crosses the configured ceiling — we catch it locally so we can
      // (a) surface a single user-visible system message in #general,
      // (b) stop the loop with `finishReason = 'budget_exceeded'`, and
      // (c) keep the Agentic Loop alive (the catch returns instead of
      // throwing). Other budget-tracking errors are unexpected; we log
      // them and treat the cycle as `retry_exhausted` for parity with
      // other transient failures.
      try {
        budget.track(response.usage, MODEL);
      } catch (err) {
        if (err instanceof Error && err.message === BUDGET_EXCEEDED_CODE) {
          logger.warn(
            { event: 'budget_exceeded', aiUserId, ...budget.getStats() },
            'AI daily budget exceeded — pausing cycles',
          );
          // Capture as a warning so on-call sees the breaker trip the
          // moment it happens; spam is bounded by the breaker itself
          // (subsequent cycles short-circuit before reaching `track`).
          Sentry.captureMessage('AI budget exceeded', {
            level: 'warning',
            extra: { ...budget.getStats(), aiUserId },
          });
          await postBudgetExceededNotice(aiUserId, workspaceId);
          finishReason = 'budget_exceeded';
          break;
        }
        throw err;
      }

      // Non-tool-use stop reasons (`end_turn`, `max_tokens`,
      // `stop_sequence`, or `null` in pathological streaming cases)
      // terminate the cycle naturally.
      if (response.stop_reason !== 'tool_use') {
        finishReason = 'stop';
        break;
      }

      // Extract every `tool_use` block from the assistant turn and
      // dispatch them in parallel. `dispatchTool` is total — it never
      // throws — so `Promise.all` is safe and the result array length
      // equals the input length 1:1 (Property 17).
      const toolUses: ToolUseBlock[] = response.content.filter(isToolUseBlock);

      const toolResults: ToolResultBlockParam[] = await Promise.all(
        toolUses.map((u) => {
          const call: ToolCall = { id: u.id, name: u.name, input: u.input };
          return dispatchTool({ aiUserId, allowedTools }, call);
        }),
      );

      // Append both halves so the next round sees the full exchange:
      // - The assistant turn (text + tool_use blocks) becomes the
      //   immediately preceding `assistant` message.
      // - The collected tool_results become the next `user` message,
      //   matching the Anthropic tool-use loop convention.
      messages.push({
        role: 'assistant',
        content: response.content,
      });
      messages.push({ role: 'user', content: toolResults });
    }

    // 5. The only way to exit the loop without `break` is by
    //    exhausting the round cap.
    if (finishReason === null) {
      finishReason = 'round_cap';
    }
  } catch (err) {
    // 6. The dispatcher is total; the only thrown errors come from
    //    `callAnthropicWithRetry` after retry exhaustion (Property 28),
    //    or from a Prisma read inside `buildInitialContext`. Either
    //    way, we surface it as `retry_exhausted` so the Agentic Loop
    //    treats this cycle as having failed.
    finishReason = 'retry_exhausted';
    logger.error(
      { event: 'ai_cycle_error', aiUserId, rounds, err },
      'AI cycle failed',
    );
    // Forward to Sentry so production crashes surface in the same
    // dashboard as API 500s and global UI errors. Tags / extras are
    // chosen to match the corresponding `logger.error` payload, so
    // operators can pivot between log lines and Sentry events.
    Sentry.captureException(err, {
      tags: { event: 'ai_cycle_error' },
      extra: { aiUserId, rounds },
    });
  } finally {
    // 7. Always pair the opening `state: true` with a single closing
    //    `state: false`, regardless of the path through the cycle.
    emitThinking(aiUserId, false);
  }

  const result: RunCycleResult = {
    aiUserId,
    rounds,
    // `finishReason` is non-null after the try/catch/finally above:
    // either we set it inside the loop, after the loop, or in catch.
    finishReason: finishReason as FinishReason,
    durationMs: Date.now() - start,
  };

  // Structured cycle-summary log (Requirement 10.5). The shape mirrors
  // {@link RunCycleResult} plus the day-to-date USD spend so consumers
  // (pino transports, log aggregators, tests, /api/admin/budget) can
  // correlate cycle outcomes with the budget breaker without joining
  // a second log stream.
  logger.info(
    {
      event: 'ai_cycle_finished',
      ...result,
      budgetTodayUSD: budget.getStats().todayUSD,
    },
    'AI cycle finished',
  );

  return result;
}

/**
 * Post a single workspace-wide system notice announcing that the AI
 * budget has tripped its daily breaker. The notice is sent through
 * `MessageService.create` so it is persisted to the channel timeline
 * AND broadcast over Socket.io exactly like a normal AI message — no
 * special-case rendering required on the client side.
 *
 * Channel resolution strategy:
 *   1. Try `#general` (the workspace's default channel, seeded by
 *      `prisma/seed.ts`).
 *   2. Fall back to the oldest channel in the workspace if `#general`
 *      somehow does not exist.
 *
 * Failures are logged but never re-thrown — the budget breaker must
 * not crash the Agentic Loop on top of already-degraded service.
 */
async function postBudgetExceededNotice(
  aiUserId: string,
  workspaceId: string,
): Promise<void> {
  // Notice text is operator-configurable via `AI_BUDGET_EXCEEDED_NOTICE`
  // so non-Chinese deployments do not have to ship a code change to
  // localise the message (audit nit L11).
  const NOTICE = env.AI_BUDGET_EXCEEDED_NOTICE;
  try {
    const channels = await ChannelService.listByWorkspace(workspaceId);
    const general = channels.find((c) => c.name === 'general');
    const target = general ?? channels[0];
    if (!target) return;
    await MessageService.create({
      channelId: target.id,
      userId: aiUserId,
      content: NOTICE,
      metadata: { event: 'budget_exceeded' },
    });
  } catch (err) {
    logger.error(
      { event: 'budget_notice_failed', aiUserId, err },
      'Failed to post budget-exceeded notice',
    );
  }
}

/**
 * Aggregated namespace export so callers can use either named imports
 * or the `AIRuntime.method(...)` style favored across the spec.
 */
export const AIRuntime = {
  runCycle,
} as const;
