/**
 * @file DeepSeek chat client (OpenAI-compatible) + bounded-retry wrapper.
 *
 * The AI runtime (`lib/ai/runtime.ts`) issues every model call through
 * {@link callAnthropicWithRetry}. The wrapper enforces an exponential
 * backoff with jitter and a hard ceiling on the number of attempts so a
 * transient upstream failure cannot turn into an unbounded retry storm
 * inside the agentic loop.
 *
 * The file name / public function names are kept on the original
 * "anthropic" terminology because (a) the upstream `runtime.ts` and the
 * test suite reference them by that name, and (b) the *contract* is
 * still "Anthropic-shape request → Anthropic-shape response". What
 * changed is the wire format: this module now translates each call
 * into an OpenAI Chat Completions request and ships it to DeepSeek
 * via the `openai` SDK, then translates the response back to the
 * Anthropic shape (`stop_reason`, `content[]` of text / tool_use
 * blocks, `usage` with `input_tokens` / `output_tokens`).
 *
 * Why keep the Anthropic shape internally? `runtime.ts` already does
 * its multi-round bookkeeping in Anthropic-style `MessageParam`s
 * (assistant `tool_use` blocks paired with user `tool_result` blocks),
 * and the test suite asserts on the same shape. Translating in/out at
 * this single boundary means the rest of the codebase — including all
 * Property tests — keeps working without semantic changes.
 *
 * Retry policy (matches the design document, "AI Runtime → Retry"):
 *
 * - First attempt counts as attempt `0`.
 * - On failure of attempt `N` where `N < MAX_RETRIES`, sleep
 *   `500 * 2^N + jitter` milliseconds, then retry. The sleeps for the
 *   three retries are therefore 500 ms, 1 s, 2 s (plus up to ~250 ms of
 *   jitter each).
 * - Total attempts = `1 + MAX_RETRIES = 4`. After the 4th failure the
 *   wrapper re-throws the error from that final attempt and `runCycle`
 *   records `finishReason = 'retry_exhausted'` (Requirement 10.2).
 *
 * Validates: Requirements 10.1 (bounded exponential backoff retry),
 *            10.2 (terminate the cycle and surface failure after the cap).
 *            Property 28: 重试上限 — for any sequence of outcomes where
 *            the first `k` attempts throw and subsequent attempts
 *            succeed, this function issues exactly `min(k, MAX_RETRIES)
 *            + 1` attempts; if `k > MAX_RETRIES` the final error is
 *            re-thrown.
 */

import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import { resolveProvider } from './providers';
import {
  type AnthropicLikeMessage,
  type AnthropicLikeMessageCreateParamsNonStreaming,
  toOpenAIMessages,
  toOpenAITools,
  toAnthropicLikeMessage,
} from './openai-bridge';

/**
 * Maximum number of retries after the initial attempt. Total attempts
 * issued by {@link callAnthropicWithRetry} are therefore
 * `1 + MAX_RETRIES = 4`.
 */
export const MAX_RETRIES = 3;

/**
 * Base backoff in milliseconds. The Nth retry (0-indexed against the
 * failed attempt) waits `BASE_BACKOFF_MS * 2 ** N` plus jitter.
 */
const BASE_BACKOFF_MS = 500;

/**
 * Maximum jitter in milliseconds added on top of the deterministic
 * backoff. Distributed uniformly in `[0, JITTER_MS)`.
 */
const JITTER_MS = 250;

/**
 * Compute the backoff delay (in ms) to sleep BEFORE the next retry,
 * given the index of the attempt that just failed.
 *
 * - `failedAttempt = 0` → ~500 ms
 * - `failedAttempt = 1` → ~1000 ms
 * - `failedAttempt = 2` → ~2000 ms
 *
 * Exposed for testability; not part of the public surface consumers
 * should rely on.
 *
 * @internal
 */
export function computeBackoffMs(failedAttempt: number): number {
  return BASE_BACKOFF_MS * 2 ** failedAttempt + Math.random() * JITTER_MS;
}

/**
 * Default `sleep` implementation backed by `setTimeout`. Resolves after
 * `ms` milliseconds. Substitute via the `options.sleep` parameter of
 * {@link callAnthropicWithRetry} for deterministic tests.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Minimal shape of the OpenAI chat completions client we depend on.
 * Declared as a structural type so tests can inject a stub without
 * pulling the full `OpenAI` instance.
 */
export interface OpenAILikeChatClient {
  readonly chat: {
    readonly completions: {
      create(req: {
        model: string;
        messages: ChatCompletionMessageParam[];
        tools?: ChatCompletionTool[];
        tool_choice?: 'auto' | 'none' | 'required';
        max_tokens?: number;
      }): Promise<ChatCompletion>;
    };
  };
}

/**
 * Optional knobs accepted by {@link callAnthropicWithRetry}. Designed
 * for dependency injection in tests; production callers should pass
 * nothing.
 */
export interface CallAnthropicWithRetryOptions {
  /**
   * Custom delay function. Receives a number of milliseconds and
   * returns a promise that settles when the delay has elapsed. When
   * omitted, the module-level {@link sleep} (a `setTimeout`-based
   * implementation) is used.
   */
  readonly sleep?: (ms: number) => Promise<void>;

  /**
   * Custom OpenAI-compatible client. When omitted, the module-level
   * {@link deepseekClient} singleton is used. Tests may inject a stub
   * that implements `chat.completions.create`.
   */
  readonly client?: OpenAILikeChatClient;
}

/**
 * Module-level chat client singleton (OpenAI-compatible).
 *
 * The concrete provider — DeepSeek (default), OpenAI, or a custom
 * OpenAI-compatible gateway — is selected by `AI_PROVIDER` and
 * resolved by `resolveProvider()` (see `lib/ai/providers.ts`).
 * Because all three speak the OpenAI Chat Completions wire format,
 * the same `openai` SDK serves every provider; only the `baseURL` /
 * `apiKey` differ.
 *
 * The active provider's API key is validated eagerly at process boot
 * by `lib/env.ts` (conditional `superRefine`), so a missing key fails
 * fast with a clear `❌ Missing env vars` diagnostic instead of an
 * opaque runtime 401.
 *
 * The export name `deepseekClient` is retained for backward
 * compatibility (tests + `runtime.ts` reference it); it now points at
 * whichever provider `AI_PROVIDER` selects.
 */
const provider = resolveProvider();

export const deepseekClient = new OpenAI({
  apiKey: provider.apiKey,
  baseURL: provider.baseURL,
});

/**
 * Identifier of the chat model the runtime targets, sourced from the
 * active provider's configuration (DeepSeek `deepseek-chat`, OpenAI
 * `gpt-4o-mini`, or the custom gateway's `AI_PROVIDER_MODEL`).
 * Override per-provider via the corresponding `*_MODEL` env var.
 */
export const MODEL: string = provider.model;

/**
 * Invoke the chat completion endpoint with bounded exponential backoff.
 *
 * Behavior:
 *
 * 1. Translate the Anthropic-shape `req` into an OpenAI Chat
 *    Completions request via {@link toOpenAIMessages} +
 *    {@link toOpenAITools} and issue the call to DeepSeek.
 * 2. If it resolves, translate the OpenAI response back into an
 *    Anthropic-shape {@link AnthropicLikeMessage} and return it. The
 *    upstream {@link runtime.ts} works exclusively on the
 *    Anthropic shape, so this single boundary keeps the rest of the
 *    codebase oblivious to which backend served the request.
 * 3. If it rejects and we have retries left, await
 *    `computeBackoffMs(attempt)` via the injected (or default) sleep,
 *    then retry. The Nth retry is preceded by ~`500 * 2^N` ms +
 *    jitter — i.e. 500 ms, 1 s, 2 s for attempts 1, 2, 3.
 * 4. After {@link MAX_RETRIES} failed retries (4 total attempts), the
 *    last error is re-thrown unchanged so the caller can record it.
 *
 * The wrapper does not classify error types; every rejection is
 * retried up to the cap. This is intentional — at the MVP scope we
 * favor simple, predictable behavior over fine-grained retry rules.
 *
 * @param req     Non-streaming Anthropic-shape request body. The
 *                streaming variant is not supported because the
 *                wrapper resolves to a single
 *                {@link AnthropicLikeMessage}.
 * @param options Optional injection points for testing
 *                ({@link CallAnthropicWithRetryOptions}).
 * @returns The successful Anthropic-shape response.
 * @throws    The final error encountered after all retries are exhausted.
 */
export async function callAnthropicWithRetry(
  req: AnthropicLikeMessageCreateParamsNonStreaming,
  options: CallAnthropicWithRetryOptions = {},
): Promise<AnthropicLikeMessage> {
  const delay = options.sleep ?? sleep;
  const client = options.client ?? (deepseekClient as OpenAILikeChatClient);

  const openaiRequest = {
    // Caller may pin a specific model on the request (the runtime
    // currently passes the same id pinned by `MODEL`); fall back to
    // the env-configured default if it is unset.
    model: req.model || MODEL,
    messages: toOpenAIMessages(req.system, req.messages),
    tools: req.tools ? toOpenAITools(req.tools) : undefined,
    tool_choice: req.tools ? ('auto' as const) : undefined,
    max_tokens: req.max_tokens,
  };

  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create(openaiRequest);
      return toAnthropicLikeMessage(response);
    } catch (err) {
      lastErr = err;

      // Out of retries — surface the most recent failure to the caller.
      if (attempt === MAX_RETRIES) break;

      await delay(computeBackoffMs(attempt));
    }
  }

  throw lastErr;
}
