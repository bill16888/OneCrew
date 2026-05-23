/**
 * @file AI tool surface (6 tools) + Zod input validation + dispatcher.
 *
 * The AI runtime (`lib/ai/runtime.ts`) hands every `tool_use` block returned
 * by Anthropic to {@link dispatchTool}. The dispatcher is the *only* path
 * from model output to side effects. It enforces three invariants that the
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

import { ApprovalService } from '@/lib/services/approval.service';
import { MessageService } from '@/lib/services/message.service';
import { TaskService } from '@/lib/services/task.service';

import { type AnthropicLikeToolResultBlock as ToolResultBlockParam } from '../openai-bridge';
import { mockReadProjectDocs, mockWebSearch } from './mocks';

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
      'Ask a human to approve a high-risk action before continuing. Use this for production changes, external communication, or any irreversible step. The cycle pauses while the approval is PENDING and resumes automatically once it is APPROVED.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        payload: { type: 'object' },
        reason: { type: 'string' },
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
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Context every tool dispatch receives from the runtime. Carries the
 * caller AI's `User.id` so side-effect branches can attribute writes
 * (e.g. `Message.userId`, `Approval.aiUserId`) to the correct AI.
 */
export interface ToolDispatchContext {
  /** `User.id` of the AI colleague on whose behalf the tool is running. */
  readonly aiUserId: string;
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

  // 2. Schema validation.
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
        const { action, payload, reason } = input as {
          action: string;
          payload?: Record<string, unknown>;
          reason: string;
        };
        await ApprovalService.create({
          aiUserId: ctx.aiUserId,
          action,
          payload: { ...(payload ?? {}), reason },
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
