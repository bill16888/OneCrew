/**
 * @file AI tool surface (6 tools) + Zod input validation + dispatcher.
 *
 * The AI runtime (`lib/ai/runtime.ts`) hands every `tool_use` block returned
 * by Anthropic to {@link dispatchTool}. The dispatcher is the *only* path
 * from model output to side effects. It enforces four invariants that the
 * design document and Property 13 ("工具调度的全函数性") require:
 *
 * 1. **Total function**: `dispatchTool` MUST always resolve to a
 *    `ToolResultBlockParam`; it MUST NOT throw, regardless of how
 *    malformed the model's output is. Failures are reported back to the
 *    model as a `tool_result` with `is_error: true` so the next round can
 *    self-correct.
 *
 * 2. **Closed tool set**: The exposed surface is exactly the 6 tools
 *    declared in {@link TOOL_DEFINITIONS}. Any tool name outside
 *    {@link TOOL_NAMES} resolves with `is_error: true` and a
 *    `Unknown tool: ...` message (Requirement 5.3, Property 12).
 *
 * 3. **Schema enforcement at the boundary**: Even though the
 *    `input_schema` is shipped to the model, we re-validate every input
 *    with Zod here before any side effect runs (Requirement 5.2,
 *    Requirement 10.3). Validation failures resolve with `is_error: true`
 *    carrying the Zod error message.
 *
 * 4. **Per-AI tool whitelist**: When the caller supplies
 *    `ctx.allowedTools` (typically read from `User.aiSettings.toolSet`),
 *    any tool outside that whitelist resolves with `is_error: true` so
 *    operators can constrain custom AIs to a subset of the surface
 *    without changing the schema list shipped to the model. An empty or
 *    missing list disables the check (preserves backwards compatibility
 *    with the default Ada/Hopper roles, which expect the full surface).
 *
 * Side-effect branches:
 *   - `create_task`, `update_task_status`, `send_channel_message`
 *     are wired to the service layer (`TaskService` / `MessageService`).
 *     Successful calls return a concise human/model-readable summary;
 *     thrown errors (validation, Prisma) are normalised to `is_error`
 *     results by the dispatcher's outer try/catch.
 *   - `request_approval` is wired to `ApprovalService.create`, which
 *     persists a PENDING `Approval` row (with `reason` folded into the
 *     payload) and broadcasts `approval:created` after the DB commit.
 *     The Agentic Loop later uses the row to pause the AI until a
 *     human decides.
 *   - `mock_web_search` and `mock_read_project_docs` return
 *     deterministic preset payloads from {@link ./mocks}.
 *
 * Validates: Requirements 5.1 (closed 6-tool surface), 5.2 (schema
 *            validation), 5.3 (unknown-tool rejection),
 *            10.3 (failed schema check yields `is_error` `tool_result`,
 *            no exception).
 */

import { z } from 'zod';

import { BUDGET_EXCEEDED_CODE, budget } from '@/lib/ai/budget';
import { env } from '@/lib/env';
import { ApprovalService } from '@/lib/services/approval.service';
import { MessageService } from '@/lib/services/message.service';
import { TaskService } from '@/lib/services/task.service';

import { type AnthropicLikeToolResultBlock as ToolResultBlockParam } from '../openai-bridge';
import { mockReadProjectDocs, mockWebSearch } from './mocks';
import { formatResults, webSearch } from './web-search';
import { withSafeExecution } from './with-safe-execution';

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic SDK shape)
// ---------------------------------------------------------------------------

/**
 * The four kanban statuses, mirrored from the design's `TaskStatus`
 * union. Declared locally with `as const` so the array literal can be
 * passed to both the JSON `enum` (in `TOOL_DEFINITIONS`) and `z.enum(...)`
 * (in `TOOL_ZOD_SCHEMAS`) without widening to `string[]`.
 *
 * Keep this in sync with `TASK_STATUSES` in `lib/services/task.service.ts`
 * once that service lands in task 7.1.
 */
const TASK_STATUS_VALUES = [
  'Backlog',
  'InProgress',
  'InReview',
  'Done',
] as const;

const APPROVAL_RISK_LEVEL_VALUES = [
  'low',
  'medium',
  'high',
] as const;

type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVEL_VALUES)[number];

interface ApprovalAnalysis {
  [key: string]: string | string[];
  background: string;
  impactScope: string;
  riskLevel: ApprovalRiskLevel;
  alternatives: string[];
}

interface ApprovalAnalysisInput {
  background?: string;
  impactScope?: string;
  riskLevel?: ApprovalRiskLevel;
  alternatives?: string;
}

/**
 * The closed set of 6 tools exposed to the model on every `runCycle`.
 *
 * Marked `as const` so:
 *  - The `name` literals propagate into {@link ToolName}, giving the rest
 *    of the runtime exhaustive type checking on tool names.
 *  - The `input_schema` JSON literals are not widened to `string`, which
 *    is critical because Anthropic's SDK expects `type: 'object'` (a
 *    literal) inside `input_schema`.
 *
 * The shape is structurally compatible with the OpenAI Chat
 * Completions tool envelope (after the small wrapper translation in
 * `lib/ai/openai-bridge.ts → toOpenAITools`). Exporting it as
 * {@link TOOL_DEFINITIONS} lets the runtime hand it to the bridge,
 * which converts each entry to `{ type: 'function', function: { name,
 * description, parameters } }` for DeepSeek.
 *
 * Validates: Requirement 5.1, Property 12 ("工具表面恒等").
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'create_task',
    description:
      'Create a new task on the kanban board. The task will start in the Backlog column with a freshly issued PROJ-{N} task ID.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200 },
        description: { type: 'string' },
        assigneeId: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task_status',
    description:
      'Move an existing task (identified by its PROJ-{N} task ID) to one of the four kanban columns.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['Backlog', 'InProgress', 'InReview', 'Done'],
        },
      },
      required: ['taskId', 'status'],
    },
  },
  {
    name: 'request_approval',
    description:
      'Ask a human to approve a high-risk action before continuing. Use this for production changes, external communication, or any irreversible step. Include structured analysis with background, impactScope, riskLevel, and alternatives so reviewers can decide quickly. The cycle pauses while the approval is PENDING and resumes automatically once it is APPROVED.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        payload: { type: 'object' },
        reason: { type: 'string' },
        analysis: {
          type: 'object',
          properties: {
            background: { type: 'string' },
            impactScope: { type: 'string' },
            riskLevel: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
            },
            alternatives: { type: 'string' },
          },
        },
      },
      required: ['action', 'reason'],
    },
  },
  {
    name: 'send_channel_message',
    description:
      'Post a message to a channel as this AI colleague. The message will be persisted and broadcast in real time exactly like a human-authored message.',
    input_schema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        content: { type: 'string', maxLength: 8000 },
      },
      required: ['channelId', 'content'],
    },
  },
  {
    name: 'mock_web_search',
    description:
      'Read-only mock web search. Returns deterministic preset results without making any outbound network calls.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mock_read_project_docs',
    description:
      'Read-only mock project documentation reader. Returns deterministic preset content without touching the filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the public web for recent information. Calls a configured search provider (Tavily by default) and returns ranked results with titles, URLs, and snippets. Use this when you need facts that may have changed since training time. Costs a small fee per call charged to the daily AI budget.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
] as const;

/**
 * Literal union of every tool name in {@link TOOL_DEFINITIONS}. Enables
 * exhaustive `switch` statements in the dispatcher and keeps the `Record`
 * key set for {@link TOOL_ZOD_SCHEMAS} aligned with the actual surface.
 */
export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

/**
 * Names of every tool the runtime will accept. Derived directly from
 * {@link TOOL_DEFINITIONS} so the surface cannot drift between the JSON
 * schema list (sent to Anthropic) and the dispatcher (executed locally).
 *
 * Validates: Property 12 ("工具表面恒等").
 */
export const TOOL_NAMES: readonly ToolName[] = TOOL_DEFINITIONS.map(
  (t) => t.name,
);

const approvalAnalysisSchema = z.object({
  background: z.string().min(1).optional(),
  impactScope: z.string().min(1).optional(),
  riskLevel: z.enum(APPROVAL_RISK_LEVEL_VALUES).optional(),
  alternatives: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Zod input validation
// ---------------------------------------------------------------------------

/**
 * Per-tool Zod schemas that mirror the JSON `input_schema` shipped to the
 * model. These are the source of truth for what `dispatchTool` actually
 * accepts: even if the model sends something the JSON schema would have
 * rejected, the Zod parser stops it here before any side effect runs.
 *
 * Keep these in sync with the corresponding `input_schema` blocks in
 * {@link TOOL_DEFINITIONS}.
 *
 * Validates: Requirements 5.2, 10.3.
 */
export const TOOL_ZOD_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  create_task: z.object({
    title: z.string().min(1).max(200),
    description: z.string().optional(),
    assigneeId: z.string().optional(),
  }),

  update_task_status: z.object({
    taskId: z.string().min(1),
    status: z.enum(TASK_STATUS_VALUES),
  }),

  request_approval: z.object({
    action: z.string().min(1),
    // Allow any object payload; the Approval row stores it as JSON.
    payload: z.record(z.unknown()).optional(),
    reason: z.string().min(1),
    analysis: approvalAnalysisSchema.optional(),
  }),

  send_channel_message: z.object({
    channelId: z.string().min(1),
    content: z.string().min(1).max(8000),
  }),

  mock_web_search: z.object({
    query: z.string().min(1),
  }),

  mock_read_project_docs: z.object({
    path: z.string().min(1),
  }),

  web_search: z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(10).optional(),
  }),
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Context every tool dispatch receives from the runtime. Carries the
 * caller AI's `User.id` so side-effect branches can attribute writes
 * (e.g. `Message.userId`, `Approval.aiUserId`) to the correct AI, and
 * an optional per-AI tool whitelist so operators can constrain custom
 * AIs to a subset of the 6-tool surface without changing the schema
 * list shipped to the model.
 */
export interface ToolDispatchContext {
  /** `User.id` of the AI colleague on whose behalf the tool is running. */
  readonly aiUserId: string;
  /**
   * Optional whitelist of tool names this AI may invoke. When `undefined`
   * (or an empty array, treated identically) the dispatcher falls back
   * to the full {@link TOOL_NAMES} surface — this preserves backwards
   * compatibility with the seeded Ada/Hopper roles, which were designed
   * before the AI-colleague editor introduced custom tool sets. When the
   * array is non-empty, any tool name outside it resolves with
   * `is_error: true` and a clear "Tool ... is not enabled" message.
   *
   * Validates: closes the door on the gap where `User.aiSettings.toolSet`
   * was persisted but never enforced (audit finding C4).
   */
  readonly allowedTools?: readonly string[];
}

/**
 * A single `tool_use` block produced by Anthropic and forwarded to the
 * dispatcher. The `input` is `unknown` because schema enforcement happens
 * inside {@link dispatchTool}, not at the call site.
 */
export interface ToolCall {
  /** Anthropic-issued ID; round-tripped as `tool_use_id` on the result. */
  readonly id: string;
  /** Tool name as reported by the model. May be outside {@link TOOL_NAMES}. */
  readonly name: string;
  /** Raw arguments the model wants to pass; validated by Zod here. */
  readonly input: unknown;
}

/**
 * Format a Zod error into a single human/model-readable line.
 *
 * Zod's default `.message` is a JSON blob of every issue, which (a) is
 * noisy in the conversation transcript and (b) blows up the context
 * budget after a few failed rounds. We collapse it into a `;`-separated
 * `path: message` summary that still tells the model exactly which field
 * was wrong without flooding the tokens.
 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Build a `tool_result` block. Centralised so every code path returns
 * exactly the shape Anthropic expects (`tool_use_id`, `type`, `content`,
 * optional `is_error`) and the dispatcher's contract stays uniform.
 */
function buildToolResult(
  toolUseId: string,
  content: string,
  isError = false,
): ToolResultBlockParam {
  const result: ToolResultBlockParam = {
    tool_use_id: toolUseId,
    type: 'tool_result',
    content,
  };
  if (isError) result.is_error = true;
  return result;
}

function firstNonBlank(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function parseAlternativeList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n|[;；]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 5);
}

function summarizeApprovalImpact(
  action: string,
  payload: Record<string, unknown> | undefined,
): string {
  const payloadKeys = Object.keys(payload ?? {}).filter(
    (key) => key !== 'reason' && key !== 'approvalAnalysis',
  );
  if (payloadKeys.length === 0) {
    return `将执行 ${action}，未提供额外参数。`;
  }
  return `将执行 ${action}，影响参数：${payloadKeys.slice(0, 8).join('、')}。`;
}

function inferApprovalRiskLevel(
  action: string,
  payload: Record<string, unknown> | undefined,
  reason: string,
): ApprovalRiskLevel {
  // Try to serialise the payload so risk-level keywords inside nested
  // fields (e.g. `payload.target = 'production-db'`) participate in the
  // matcher below. A cyclic payload makes JSON.stringify throw; in that
  // case we conservatively bump the implicit risk floor — a model that
  // produces a self-referencing object is already misbehaving, and we
  // would rather route it through human review than silently classify
  // as low.
  let serializedPayload = '';
  let payloadSerializationFailed = false;
  try {
    serializedPayload = JSON.stringify(payload ?? {});
  } catch {
    payloadSerializationFailed = true;
  }

  const text = `${action} ${reason} ${serializedPayload}`.toLowerCase();

  if (
    /delete|drop|destroy|payment|billing|prod|production|生产|删除|付款|计费/.test(
      text,
    )
  ) {
    return 'high';
  }
  if (
    /deploy|release|external|email|customer|database|migration|部署|发布|外部|邮件|客户|数据库|迁移/.test(
      text,
    )
  ) {
    return 'high';
  }
  if (/public|notify|send|message|公开|通知|发送/.test(text)) {
    return 'medium';
  }
  // Audit nit L8: cyclic payload → escalate the floor from medium to
  // high so the human reviewer sees the risk surface, not a misleading
  // "looks fine" assignment.
  return payloadSerializationFailed ? 'high' : 'medium';
}

function normalizeApprovalAnalysis({
  action,
  payload,
  reason,
  analysis,
}: {
  action: string;
  payload: Record<string, unknown> | undefined;
  reason: string;
  analysis: ApprovalAnalysisInput | undefined;
}): ApprovalAnalysis {
  const alternatives = parseAlternativeList(analysis?.alternatives);

  return {
    background:
      firstNonBlank(analysis?.background, reason) ??
      `需要人工确认 ${action} 是否应该继续执行。`,
    impactScope:
      firstNonBlank(analysis?.impactScope) ??
      summarizeApprovalImpact(action, payload),
    riskLevel:
      analysis?.riskLevel ?? inferApprovalRiskLevel(action, payload, reason),
    alternatives:
      alternatives.length > 0
        ? alternatives
        : [
            '暂缓执行，等待人工补充更多上下文。',
            `将 ${action} 拆成更小步骤，先验证低风险部分。`,
          ],
  };
}

/**
 * Dispatch a single `tool_use` call to its handler.
 *
 * Resolution order:
 *
 * 1. **Unknown tool** → return `is_error: true` with
 *    `Unknown tool: ${name}`. The model can self-correct on the next
 *    round (Requirement 5.3).
 *
 * 2. **Schema validation** via {@link TOOL_ZOD_SCHEMAS}. If the parse
 *    fails, return `is_error: true` with `Invalid arguments: ${msg}`
 *    (Requirements 5.2 / 10.3).
 *
 * 3. **Side-effect branch**. Each tool has a dedicated branch:
 *      - `create_task` / `update_task_status` / `send_channel_message`
 *        delegate to `TaskService` / `MessageService` and return a
 *        concise success summary (task 7.2).
 *      - `mock_web_search` / `mock_read_project_docs` return
 *        deterministic preset payloads from `./mocks` (task 7.3).
 *      - `request_approval` delegates to `ApprovalService.create`,
 *        persisting a PENDING approval and broadcasting
 *        `approval:created` once the write commits (task 9.3).
 *
 * The function is total: it MUST NOT throw. Any unexpected runtime error
 * inside a branch is caught and converted into an `is_error` result so
 * the parent `runCycle` can keep its accounting honest
 * (Property 13: 工具调度的全函数性).
 *
 * @param ctx  Caller-side context (the AI's user id).
 * @param call A single `tool_use` block from the model.
 * @returns A `tool_result` block ready to be appended to the next user
 *   message in the multi-round conversation.
 */
export async function dispatchTool(
  ctx: ToolDispatchContext,
  call: ToolCall,
): Promise<ToolResultBlockParam> {
  // 1. Unknown tool guard. Use `Object.hasOwn` to avoid hitting
  //    inherited properties like `constructor` / `toString` /
  //    `hasOwnProperty`, which would otherwise resolve to a non-Zod
  //    value on `TOOL_ZOD_SCHEMAS` and crash the dispatch loop.
  const schemaMap = TOOL_ZOD_SCHEMAS as Record<string, z.ZodTypeAny>;
  if (!Object.prototype.hasOwnProperty.call(schemaMap, call.name)) {
    return buildToolResult(call.id, `Unknown tool: ${call.name}`, true);
  }
  const schema = schemaMap[call.name];

  // 2. Per-AI whitelist guard. When the runtime supplies an explicit
  //    allowlist (read from `User.aiSettings.toolSet`), reject any tool
  //    not in the list. An empty array is treated as "no list provided"
  //    so seeded AIs without custom config retain the full surface.
  if (
    Array.isArray(ctx.allowedTools) &&
    ctx.allowedTools.length > 0 &&
    !ctx.allowedTools.includes(call.name)
  ) {
    return buildToolResult(
      call.id,
      `Tool '${call.name}' is not enabled for this AI. Allowed: ${ctx.allowedTools.join(', ')}.`,
      true,
    );
  }

  // 3. Schema validation.
  const parsed = schema.safeParse(call.input);
  if (!parsed.success) {
    return buildToolResult(
      call.id,
      `Invalid arguments: ${formatZodError(parsed.error)}`,
      true,
    );
  }

  // From here on, `call.name` is one of the 6 known names because the
  // schema lookup succeeded. Cast once and `switch` exhaustively so any
  // future addition to TOOL_DEFINITIONS triggers a compile error here.
  const name = call.name as ToolName;
  const input = parsed.data as unknown;

  try {
    switch (name) {
      case 'create_task': {
        // Wire to TaskService.create. The validated input shape mirrors
        // TOOL_ZOD_SCHEMAS.create_task: { title, description?, assigneeId? }.
        // The service derives `isAITask` from the creator/assignee `isAI`
        // flags and broadcasts `task:updated` only after the DB commit
        // (Property 9: 任务创建/更新—广播一致性).
        //
        // The returned summary explicitly mentions `(status: Backlog)`
        // because Requirement 3.3 fixes the initial status of every new
        // task; surfacing it in the tool_result keeps the model from
        // ever guessing a different starting column on the next round.
        const { title, description, assigneeId } = input as {
          title: string;
          description?: string;
          assigneeId?: string;
        };
        const task = await TaskService.create({
          title,
          description,
          creatorId: ctx.aiUserId,
          assigneeId,
        });
        return buildToolResult(
          call.id,
          `Created task ${task.taskId}: "${task.title}" (status: Backlog)`,
        );
      }

      case 'update_task_status': {
        // Wire to TaskService.updateStatus. The service re-validates the
        // status against TASK_STATUSES (Property 8: 状态更新值域) and
        // broadcasts `task:updated` only after the DB commit. A missing
        // task or invalid status will throw and be normalised to an
        // `is_error` result by the outer try/catch (Property 13).
        //
        // We echo back `task.status` (not `input.status`) so the model
        // sees the post-commit status straight from the persisted row.
        const { taskId, status } = input as {
          taskId: string;
          status: (typeof TASK_STATUS_VALUES)[number];
        };
        const task = await TaskService.updateStatus(taskId, status);
        return buildToolResult(
          call.id,
          `Moved ${task.taskId} to ${task.status}`,
        );
      }

      case 'send_channel_message': {
        // Wire to MessageService.create with userId = ctx.aiUserId so
        // sender attribution holds (Property 15: send_channel_message
        // 工具的发送者归属). The service handles content validation
        // (non-blank, ≤ 8000 chars) and broadcasts `message:new` only
        // after the DB commit (Property 3 / Property 4 fromAI flag).
        const { channelId, content } = input as {
          channelId: string;
          content: string;
        };
        await MessageService.create({
          channelId,
          userId: ctx.aiUserId,
          content,
        });
        return buildToolResult(call.id, `Sent message in channel ${channelId}`);
      }

      case 'request_approval': {
        // Wire to ApprovalService.create with aiUserId = ctx.aiUserId so
        // the Agentic Loop's PENDING gate can later locate this row and
        // pause this AI's next cycle (Requirements 5.8 / 6.1, Property
        // 16: 审批创建—广播一致性).
        //
        // The model-supplied `payload` is optional (defaults to `{}`)
        // and `reason` is folded into the persisted payload so reviewers
        // see *why* the AI requested approval alongside the structured
        // action parameters. Persistence + `approval:created` broadcast
        // both happen inside ApprovalService.create; any thrown error
        // (Prisma write, unknown aiUserId) is normalised to an
        // `is_error` tool_result by the outer try/catch (Property 13).
        const {
          action,
          payload,
          reason,
          analysis: requestedAnalysis,
        } = input as {
          action: string;
          payload?: Record<string, unknown>;
          reason: string;
          analysis?: ApprovalAnalysisInput;
        };
        const analysis = normalizeApprovalAnalysis({
          action,
          payload,
          reason,
          analysis: requestedAnalysis,
        });
        await ApprovalService.create({
          aiUserId: ctx.aiUserId,
          action,
          payload: { ...(payload ?? {}), reason, approvalAnalysis: analysis },
        });
        return buildToolResult(
          call.id,
          `Approval requested for "${action}"; waiting for human review.`,
        );
      }

      case 'mock_web_search': {
        // Task 7.3: Deterministic preset results. mockWebSearch is
        // pure — no fetch, no fs, no clock — which keeps Property 14
        // ("Mock 工具的纯净性") intact.
        const { query } = input as { query: string };
        return buildToolResult(call.id, mockWebSearch(query));
      }

      case 'mock_read_project_docs': {
        // Task 7.3: Deterministic preset content. mockReadProjectDocs
        // is pure — no fs, no fetch, no clock — preserving
        // Property 14 ("Mock 工具的纯净性").
        const { path } = input as { path: string };
        return buildToolResult(call.id, mockReadProjectDocs(path));
      }

      case 'web_search': {
        // Phase 1 Req 12.2 — real web search. Routed through
        // `withSafeExecution` so the dispatcher's totality guarantee
        // (Property 13) survives provider 4xx/5xx, timeouts, and
        // missing API keys (Req 12.4). Successful calls charge
        // `WEB_SEARCH_COST_USD` against the daily budget so a
        // runaway loop can't bypass the breaker (Req 12.6 + audit M1).
        const { query, maxResults } = input as {
          query: string;
          maxResults?: number;
        };
        const result = await withSafeExecution(
          { toolName: 'web_search' },
          async (signal) => {
            const rows = await webSearch(query, { maxResults, signal });
            // Account for the per-call cost only on success. Failures
            // throw (caught by withSafeExecution) and never reach this
            // line, so a misconfigured provider never charges the budget.
            try {
              budget.trackOther(env.WEB_SEARCH_COST_USD, 'web_search');
            } catch (budgetErr) {
              // Budget exceeded mid-call: still surface the search
              // results we already paid for, but log the trip so the
              // runtime's outer guard catches it on the next round.
              if (
                budgetErr instanceof Error &&
                budgetErr.message === BUDGET_EXCEEDED_CODE
              ) {
                // Swallow — runtime's per-cycle gate will pause the
                // next round; surfacing results we already paid for
                // is strictly better than discarding them.
              } else {
                throw budgetErr;
              }
            }
            return formatResults(query, rows);
          },
        );
        return buildToolResult(call.id, result.content, !result.ok);
      }

      default: {
        // Exhaustiveness guard: if a new tool is added to ToolName
        // without a matching case branch, this assignment becomes a
        // compile-time error.
        const _exhaustive: never = name;
        return buildToolResult(
          call.id,
          `Unhandled tool: ${String(_exhaustive)}`,
          true,
        );
      }
    }
  } catch (err) {
    // Property 13 demands totality. Any thrown error inside a branch
    // (a real possibility once the TODOs hit the network / DB) is
    // converted into an `is_error` result instead of bubbling up.
    const message = err instanceof Error ? err.message : String(err);
    return buildToolResult(call.id, `Tool execution failed: ${message}`, true);
  }
}
