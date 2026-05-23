/**
 * @file Translation layer between the Anthropic-shape conversation
 * format used internally by `lib/ai/runtime.ts` + the AI Property tests
 * and the OpenAI Chat Completions wire format spoken by DeepSeek.
 *
 * The runtime keeps using Anthropic-style transcripts because:
 *   - The multi-round `tool_use` loop in `runCycle` was designed
 *     against Anthropic's content-block model (assistant messages
 *     interleave `text` and `tool_use` blocks; the next user message
 *     carries one `tool_result` per `tool_use` id) and the Property
 *     tests assert on that exact structure (`Property 17`,
 *     `Property 22`, etc.).
 *   - Switching transcripts to OpenAI's `role: 'tool'` shape would
 *     require rewriting every test fixture; doing the translation at
 *     the SDK boundary instead keeps the change surface minimal.
 *
 * ## Anthropic → OpenAI translation
 *
 * - System prompt is NOT a message in Anthropic; in OpenAI it becomes
 *   `{ role: 'system', content }` prepended to the message array.
 * - User message with `content: string` →
 *   `{ role: 'user', content: string }`.
 * - Assistant message with text-only `content` →
 *   `{ role: 'assistant', content: <joined text> }`.
 * - Assistant message containing `tool_use` blocks →
 *   `{ role: 'assistant', content: <joined text or null>,
 *      tool_calls: [{ id, type: 'function', function: { name,
 *      arguments: JSON.stringify(input) } }] }`.
 * - User message whose `content` is an array of `tool_result` blocks
 *   is split into one OpenAI `{ role: 'tool', tool_call_id, content }`
 *   per block — OpenAI's spec requires one tool message per tool call.
 *
 * ## OpenAI → Anthropic translation
 *
 * - `choices[0].finish_reason === 'tool_calls'` becomes
 *   `stop_reason: 'tool_use'` so the runtime's existing
 *   `if (response.stop_reason !== 'tool_use')` branch fires correctly
 *   on round-cap continuation.
 * - `choices[0].finish_reason === 'stop'` / `'length'` /
 *   anything-else becomes `stop_reason: 'end_turn' | 'max_tokens' |
 *   '<verbatim>'`. The runtime only branches on `=== 'tool_use'`, so
 *   any non-`tool_use` value flows through the natural-stop path and
 *   produces `finishReason: 'stop'`.
 * - `choices[0].message.tool_calls[]` become Anthropic-shape
 *   `tool_use` blocks (`{ type: 'tool_use', id, name, input }`),
 *   parsing `function.arguments` from JSON. A malformed JSON payload
 *   is surfaced as `input: {}` so the dispatcher's Zod validator can
 *   reject the call with a structured `is_error` tool_result; that
 *   keeps Property 13 ("dispatchTool is total") intact.
 * - `usage.prompt_tokens` / `usage.completion_tokens` map to
 *   `usage.input_tokens` / `usage.output_tokens`, matching the field
 *   names `lib/ai/budget.ts` consumes.
 */

import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

// ---------------------------------------------------------------------------
// Anthropic-like type definitions (replaces `@anthropic-ai/sdk` types)
// ---------------------------------------------------------------------------

/**
 * A `text` content block produced by the assistant. We do not currently
 * forward `text` to the model side (the runtime appends the entire
 * assistant `content` array verbatim into the transcript), but the type
 * is declared for completeness so consumers can do exhaustive checks
 * against `block.type`.
 */
export interface AnthropicLikeTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * A `tool_use` content block returned by the assistant. The runtime
 * iterates these blocks to decide which tools to dispatch on the next
 * round. Mirrors the Anthropic SDK's `ToolUseBlock` shape.
 */
export interface AnthropicLikeToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Union of every assistant content block kind we forward through the
 * runtime. Currently `text` and `tool_use`; if DeepSeek begins
 * surfacing additional block kinds (images, redacted content, etc.)
 * extend this union and the translator below in lockstep.
 */
export type AnthropicLikeContentBlock =
  | AnthropicLikeTextBlock
  | AnthropicLikeToolUseBlock;

/**
 * A `tool_result` content block emitted by the runtime on the next
 * user message after a tool dispatch. The dispatcher in
 * `lib/ai/tools/index.ts` returns objects of this shape; the runtime
 * batches them and the bridge converts each into a separate OpenAI
 * `{ role: 'tool', tool_call_id, content }` message on the wire.
 *
 * Fields are intentionally NOT marked `readonly`: the dispatcher
 * builds the object incrementally (sets `is_error` last when it
 * applies), and downstream consumers treat the value as a plain
 * JSON-shaped struct — wrapping it in `Readonly<>` would force every
 * call site to satisfy the immutable shape without buying any
 * additional safety beyond what the explicit field types already
 * provide.
 */
export interface AnthropicLikeToolResultBlock {
  tool_use_id: string;
  type: 'tool_result';
  content: string;
  is_error?: boolean;
}

/**
 * One entry in the rolling Anthropic-shape conversation transcript.
 *
 * - `user` messages carry either a plain string (the round-1 digest)
 *   OR an array of `tool_result` blocks (every round after a tool
 *   dispatch).
 * - `assistant` messages carry an array of mixed text / tool_use
 *   blocks — exactly the `content` field returned by the previous
 *   round's response.
 */
export type AnthropicLikeMessageParam =
  | { role: 'user'; content: string | AnthropicLikeToolResultBlock[] }
  | { role: 'assistant'; content: AnthropicLikeContentBlock[] };

/**
 * Tool advertisement Anthropic-style: `{ name, description,
 * input_schema: { type: 'object', properties, required } }`.
 *
 * The runtime keeps this shape because the property tests in
 * `tests/lib/ai/tools.test.ts` assert that the tool surface advertised
 * to the model is bit-for-bit identical to `TOOL_DEFINITIONS`. The
 * bridge translates each entry into the OpenAI
 * `{ type: 'function', function: { name, description, parameters } }`
 * envelope at request time.
 */
export interface AnthropicLikeTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

/**
 * Non-streaming request body the runtime hands to
 * {@link callAnthropicWithRetry}. Mirrors the fields of the
 * Anthropic SDK's `MessageCreateParamsNonStreaming` we actually use.
 */
export interface AnthropicLikeMessageCreateParamsNonStreaming {
  readonly model: string;
  readonly system: string;
  readonly tools: readonly AnthropicLikeTool[];
  readonly messages: readonly AnthropicLikeMessageParam[];
  readonly max_tokens: number;
}

/**
 * Anthropic-shape response. `runCycle` only consults
 * `stop_reason`, `content[]`, and `usage`, so the bridge only has to
 * fill those three fields plus a synthetic `id` / `model` / `role` to
 * keep the type checker happy.
 */
export interface AnthropicLikeMessage {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly model: string;
  readonly content: AnthropicLikeContentBlock[];
  /**
   * `'tool_use'` when the assistant wants to call tools, `'end_turn'`
   * for a natural stop, `'max_tokens'` when the output cap was hit.
   * The runtime only branches on `=== 'tool_use'`; everything else is
   * treated as a natural stop.
   */
  readonly stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  readonly stop_sequence: string | null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Anthropic → OpenAI
// ---------------------------------------------------------------------------

/**
 * Translate Anthropic-shape tool advertisements into the OpenAI tool
 * envelope used by Chat Completions. Pure function; safe to call once
 * per request.
 *
 * Both shapes carry the same JSON Schema for `parameters` /
 * `input_schema`; only the wrapping field names differ.
 */
export function toOpenAITools(
  tools: readonly AnthropicLikeTool[],
): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      // OpenAI types `parameters` as `Record<string, unknown>`. The
      // input_schema is structurally compatible because Zod-derived
      // JSON Schemas use the same `{ type: 'object', properties,
      // required }` envelope on both sides.
      parameters: tool.input_schema as unknown as Record<string, unknown>,
    },
  }));
}

/**
 * Stringify an assistant message's `text` blocks into a single string
 * suitable for OpenAI's `content` field. Returns `null` when the
 * assistant turn carries only `tool_use` blocks (OpenAI accepts a
 * `null` content alongside `tool_calls`, which is exactly the shape
 * the assistant turn becomes after translation).
 */
function joinTextBlocks(
  content: readonly AnthropicLikeContentBlock[],
): string | null {
  const text = content
    .filter((b): b is AnthropicLikeTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text.length > 0 ? text : null;
}

/**
 * Translate the Anthropic-shape conversation transcript into OpenAI
 * Chat Completions `messages`. Prepends the system prompt as a
 * `{ role: 'system' }` entry so DeepSeek receives it on every round.
 *
 * Every Anthropic `user` message whose content is an array of
 * `tool_result` blocks fans out into one OpenAI
 * `{ role: 'tool', tool_call_id, content }` message per block — the
 * OpenAI tool-calling protocol requires one tool message per tool
 * call ID, NOT a single batched payload.
 *
 * @param system  System prompt to inject as the first message.
 * @param history Rolling Anthropic-shape transcript.
 * @returns       OpenAI-shape messages ready to ship to DeepSeek.
 */
export function toOpenAIMessages(
  system: string,
  history: readonly AnthropicLikeMessageParam[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  for (const msg of history) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }
      // Array of tool_result blocks → one OpenAI tool message per block.
      for (const block of msg.content) {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
      continue;
    }

    // Assistant turn. May carry text blocks, tool_use blocks, or both.
    const toolUses = msg.content.filter(
      (b): b is AnthropicLikeToolUseBlock => b.type === 'tool_use',
    );
    const textContent = joinTextBlocks(msg.content);

    if (toolUses.length === 0) {
      // Pure text reply.
      out.push({ role: 'assistant', content: textContent ?? '' });
      continue;
    }

    out.push({
      role: 'assistant',
      content: textContent,
      tool_calls: toolUses.map((u) => ({
        id: u.id,
        type: 'function',
        function: {
          name: u.name,
          // OpenAI expects the JSON-serialised arguments string. The
          // assistant might have returned anything in `input`; we
          // serialise faithfully and let the model see its own prior
          // arguments unchanged on the next round.
          arguments: JSON.stringify(u.input ?? {}),
        },
      })),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// OpenAI → Anthropic
// ---------------------------------------------------------------------------

/**
 * Map an OpenAI `finish_reason` to an Anthropic-shape `stop_reason`.
 *
 * The runtime branches on `=== 'tool_use'`; every non-`tool_use`
 * value flows through the natural-stop path. We still distinguish a
 * few common values so structured logs / future code paths can
 * pattern-match more meaningfully.
 */
function mapFinishReason(
  finish: ChatCompletion.Choice['finish_reason'],
): AnthropicLikeMessage['stop_reason'] {
  switch (finish) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    default:
      // `content_filter`, `function_call` (deprecated), null, etc.
      // → treat as natural stop so the runtime exits the loop.
      return 'end_turn';
  }
}

/**
 * Parse a `tool_call.function.arguments` JSON string into a
 * structured `input`. A malformed payload (DeepSeek occasionally
 * emits truncated JSON when `max_tokens` clips a tool call) becomes
 * `{}` so downstream Zod validation in `dispatchTool` rejects the
 * call with a clean `is_error` tool_result rather than throwing
 * inside the runtime — keeping Property 13 (dispatcher totality)
 * intact.
 */
function parseToolArguments(raw: string | null | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Translate an OpenAI `ChatCompletion` response into the
 * Anthropic-shape `AnthropicLikeMessage` the runtime + tests assume.
 *
 * Behavior:
 *   - The first choice's message is canonical (we do not request
 *     `n > 1`).
 *   - `message.tool_calls[]` become Anthropic `tool_use` blocks.
 *   - `message.content` (when non-empty) becomes a single Anthropic
 *     `text` block prepended to the tool_use blocks. The runtime
 *     persists the entire `content` array onto the next assistant
 *     turn, so this preserves the model's natural-language reasoning
 *     alongside its tool calls.
 *   - `usage.prompt_tokens` / `usage.completion_tokens` map to
 *     `input_tokens` / `output_tokens` (the field names the budget
 *     tracker consumes).
 *
 * @throws Never. Pure transformation; missing optional fields are
 *   filled with neutral defaults so the runtime always sees a
 *   well-formed `AnthropicLikeMessage`.
 */
export function toAnthropicLikeMessage(
  response: ChatCompletion,
): AnthropicLikeMessage {
  const choice = response.choices[0];
  const message = choice?.message;

  const blocks: AnthropicLikeContentBlock[] = [];

  if (message?.content && message.content.length > 0) {
    blocks.push({ type: 'text', text: message.content });
  }

  for (const call of message?.tool_calls ?? []) {
    // OpenAI's tool_calls union covers function calls + (eventually)
    // other call types. We only request `function` tools; defensively
    // skip anything else so a future OpenAI server-side change does
    // not crash the runtime.
    if (call.type !== 'function') continue;
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    });
  }

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: blocks,
    stop_reason: mapFinishReason(choice?.finish_reason ?? 'stop'),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}
