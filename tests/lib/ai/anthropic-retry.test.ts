/**
 * @file Property test for `lib/ai/anthropic.ts`.
 *
 * Covers Property 28 (重试上限): for any sequence of outcomes where
 * the first `k` attempts throw and subsequent attempts succeed,
 * `callAnthropicWithRetry` issues exactly `min(k, MAX_RETRIES) + 1`
 * attempts; if `k > MAX_RETRIES` it ultimately rethrows.
 *
 * The wrapper now translates Anthropic-shape requests into OpenAI
 * Chat Completions calls against DeepSeek under the hood. The retry
 * machinery is wire-format-agnostic: this test injects a stub
 * OpenAI-compatible client (`{ chat: { completions: { create } } }`)
 * and a fake `sleep` so the test is fully deterministic — no real
 * timers, no real network.
 *
 * Validates: Requirements 10.1, 10.2 (P2 task 6.12).
 */

import '../../setup';

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { ChatCompletion } from 'openai/resources/chat/completions';

import {
  MAX_RETRIES,
  type OpenAILikeChatClient,
  callAnthropicWithRetry,
} from '@/lib/ai/anthropic';
import type { AnthropicLikeMessageCreateParamsNonStreaming } from '@/lib/ai/openai-bridge';

const STUB_REQUEST: AnthropicLikeMessageCreateParamsNonStreaming = {
  model: 'deepseek-chat',
  max_tokens: 64,
  system: 'you are a test',
  tools: [],
  messages: [{ role: 'user', content: 'hi' }],
};

const STUB_RESPONSE: ChatCompletion = {
  id: 'chatcmpl_x',
  object: 'chat.completion',
  created: 0,
  model: 'deepseek-chat',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'ok',
        refusal: null,
      },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
} as unknown as ChatCompletion;

/**
 * Build a stub `chat.completions.create` that throws on the first
 * `failuresBefore` attempts and resolves on every subsequent call.
 * Returns the matching {@link OpenAILikeChatClient} stub plus a
 * `callCount()` helper.
 */
function buildStubClient(failuresBefore: number): {
  client: OpenAILikeChatClient;
  callCount: () => number;
} {
  let calls = 0;
  const create = vi.fn(async () => {
    calls++;
    if (calls <= failuresBefore) {
      throw new Error(`stub-failure-${calls}`);
    }
    return STUB_RESPONSE;
  });
  return {
    client: {
      chat: { completions: { create } },
    } as OpenAILikeChatClient,
    callCount: () => calls,
  };
}

describe('Feature: ai-native-team-workspace, Property 28: 重试上限', () => {
  it('issues exactly min(k, MAX_RETRIES) + 1 attempts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_RETRIES + 5 }),
        async (k) => {
          const { client, callCount } = buildStubClient(k);
          const sleep = vi.fn(async () => {});

          if (k <= MAX_RETRIES) {
            const res = await callAnthropicWithRetry(STUB_REQUEST, {
              client,
              sleep,
            });
            // The wrapper translates the OpenAI response back into the
            // Anthropic-shape envelope; we only sanity-check that we
            // got a well-formed message back so the property focuses
            // on call counts (the retry contract).
            expect(res.role).toBe('assistant');
            expect(res.type).toBe('message');
            // Exactly k failed attempts + 1 successful attempt.
            expect(callCount()).toBe(k + 1);
            // Sleep called once between each pair of attempts.
            expect(sleep).toHaveBeenCalledTimes(k);
          } else {
            await expect(
              callAnthropicWithRetry(STUB_REQUEST, { client, sleep }),
            ).rejects.toThrow(/stub-failure/);
            // 1 initial + MAX_RETRIES retries = MAX_RETRIES + 1 calls.
            expect(callCount()).toBe(MAX_RETRIES + 1);
            // Sleep is called between attempts but NOT after the
            // final failure.
            expect(sleep).toHaveBeenCalledTimes(MAX_RETRIES);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('returns immediately on success (no sleeps)', async () => {
    const { client } = buildStubClient(0);
    const sleep = vi.fn(async () => {});
    await callAnthropicWithRetry(STUB_REQUEST, { client, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
});
