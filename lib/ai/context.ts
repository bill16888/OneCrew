/**
 * @file Context-window trimming for the AI runtime.
 *
 * The Anthropic SDK accepts a `messages` array bounded by a token budget.
 * `runCycle` (lib/ai/runtime.ts) accumulates an ever-growing transcript
 * across up to 5 tool-use rounds, so we need a deterministic, side-effect
 * free strategy to keep the context under the model's hard limit.
 *
 * This module exposes two functions:
 *
 * - `estimateTokens(content)` — A cheap, deterministic token estimator.
 *   Strings count as `ceil(length / 4)` tokens (the canonical "≈4 chars
 *   per token" heuristic). Arrays of content blocks (the Anthropic
 *   `MessageParam.content` shape — `text` blocks, `tool_use` blocks,
 *   `tool_result` blocks) are walked structurally.
 *
 * - `trimContextToTokenBudget(messages, tokenBudget)` — Returns a
 *   contiguous SUFFIX of the input whose summed estimate is `≤ budget`.
 *   Older entries (head) are dropped first; the most recent rounds are
 *   preserved. The input array is never mutated.
 *
 * The signature is generic over any object that exposes `role` and
 * `content`, so it works with `Anthropic.MessageParam` from the SDK
 * without taking a hard dependency on it.
 *
 * Validates: Requirements 7.5 (truncate older context, keep newest).
 *            Property 23 (returned slice is a contiguous suffix of
 *            `messages` whose estimated tokens are `≤ tokenBudget`).
 */

/**
 * Heuristic ratio of UTF-16 characters to estimated tokens. The Anthropic
 * tokenizer is BPE-based, so this is intentionally coarse — the goal is
 * to stay safely under the model's hard limit, not to match the
 * tokenizer exactly.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Minimal structural shape of a conversation message. Kept loose so this
 * module does not depend on the Anthropic SDK types directly. Any object
 * exposing `role` and `content` (including `Anthropic.MessageParam`) is
 * accepted.
 */
export interface ConversationMessageLike {
  readonly role: string;
  readonly content: unknown;
}

/**
 * Estimate the token cost of a single piece of message content.
 *
 * Behavior by input shape:
 * - `string` → `ceil(length / 4)`
 * - `Array` → sum of `estimateTokens` over each element (matches the
 *   Anthropic content-block list shape)
 * - object with a `text: string` field (e.g. a `text` block or a
 *   `tool_use` input snippet) → estimate of that text
 * - object with `content: string | unknown[]` (e.g. a `tool_result`
 *   block) → estimate of that nested content
 * - any other object → estimate of its JSON serialization length
 * - `null` / `undefined` / unserializable values → `0`
 *
 * The function is total: it never throws.
 */
export function estimateTokens(content: unknown): number {
  if (content === null || content === undefined) return 0;

  if (typeof content === 'string') {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }

  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      total += estimateTokens(block);
    }
    return total;
  }

  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;

    // Common Anthropic block shapes carry their payload on a single
    // semantic field. Prefer those so we don't double-count surrounding
    // metadata (`type`, `id`, etc.).
    if (typeof obj.text === 'string') {
      return estimateTokens(obj.text);
    }
    if (typeof obj.content === 'string' || Array.isArray(obj.content)) {
      return estimateTokens(obj.content);
    }

    // Generic object (e.g. a `tool_use` block's `input` payload):
    // fall back to the JSON length heuristic.
    try {
      return Math.ceil(JSON.stringify(obj).length / CHARS_PER_TOKEN);
    } catch {
      // Cyclic or otherwise unserializable — treat as zero rather than throw.
      return 0;
    }
  }

  // Numbers, booleans, bigints, symbols. Coerce to string for a rough
  // size and apply the same ratio.
  return Math.ceil(String(content).length / CHARS_PER_TOKEN);
}

/**
 * Trim a conversation transcript to fit within `tokenBudget` by dropping
 * the OLDEST messages first. The returned array is always a contiguous
 * SUFFIX of `messages` (preserving relative order) whose summed
 * estimated tokens are `≤ tokenBudget`.
 *
 * Edge cases:
 * - `tokenBudget <= 0` (or `NaN`/`Infinity` rejected as non-finite) → `[]`.
 * - `messages` empty → `[]`.
 * - The single tail message already exceeds the budget → `[]`. Property
 *   23 requires the returned tokens to be `≤ budget`, so we prefer
 *   returning nothing over violating the invariant.
 *
 * The input array is never mutated.
 *
 * @param messages   The full transcript, oldest first.
 * @param tokenBudget Maximum total estimated tokens to retain.
 * @returns A contiguous suffix of `messages` whose estimated token total
 *   is `≤ tokenBudget`.
 */
export function trimContextToTokenBudget<T extends ConversationMessageLike>(
  messages: readonly T[],
  tokenBudget: number,
): T[] {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return [];
  if (messages.length === 0) return [];

  let used = 0;
  // `firstKeptIndex` stays at `messages.length` while no message fits;
  // `slice(messages.length)` correctly returns `[]` in that case.
  let firstKeptIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i].content);
    if (used + cost > tokenBudget) break;
    used += cost;
    firstKeptIndex = i;
  }

  return messages.slice(firstKeptIndex);
}
