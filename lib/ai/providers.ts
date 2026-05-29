/**
 * @file Pluggable chat-provider resolution (Phase 1 Req 14).
 *
 * The runtime issues every model call through `lib/ai/anthropic.ts`,
 * which translates the internal Anthropic-shape request into the
 * OpenAI Chat Completions wire format and ships it via the `openai`
 * SDK. Because DeepSeek, OpenAI (incl. Azure), and most self-hosted
 * gateways (vLLM / Ollama / LiteLLM) all speak that same wire format,
 * switching providers is purely a matter of which `baseURL` /
 * `apiKey` / `model` the SDK is constructed with — the retry wrapper
 * and the Anthropic↔OpenAI bridge are provider-agnostic and stay
 * untouched.
 *
 * This module centralises that selection. `resolveProvider()` reads
 * `AI_PROVIDER` (validated at boot in `lib/env.ts`, including the
 * conditional API-key requirement) and returns the concrete config
 * the client singleton in `lib/ai/anthropic.ts` consumes.
 *
 * Native Anthropic (Claude) is intentionally NOT a provider here: its
 * API is not OpenAI-compatible and would require a separate request /
 * response adapter plus the `@anthropic-ai/sdk` dependency. That is a
 * tracked Phase 1 follow-up. Operators who need Claude today can point
 * `AI_PROVIDER=custom` at an OpenAI-compatible Claude proxy.
 *
 * Validates: Phase 1 Req 14.1, 14.2, 14.3.
 */

import { env } from '@/lib/env';

/** Resolved configuration for the active OpenAI-compatible provider. */
export interface ProviderConfig {
  /** Stable provider identifier (matches `AI_PROVIDER`). */
  readonly name: 'deepseek' | 'openai' | 'custom';
  /** API key passed to the OpenAI SDK constructor. */
  readonly apiKey: string;
  /** Base URL for the OpenAI-compatible endpoint. */
  readonly baseURL: string;
  /** Default model id used when a request does not pin one. */
  readonly model: string;
}

/**
 * Resolve the active provider's configuration from the validated
 * environment.
 *
 * `lib/env.ts` already guarantees (via `superRefine`) that the active
 * provider's API key — and, for `custom`, its base URL + model — are
 * present, so this function does not re-validate; it simply maps the
 * env values onto {@link ProviderConfig}.
 *
 * Read lazily (per call) rather than memoised so tests can mutate
 * `process.env` / the `env` object between cases. In production the
 * values are stable for the process lifetime, so the cost of
 * re-reading three fields is negligible.
 */
export function resolveProvider(): ProviderConfig {
  switch (env.AI_PROVIDER) {
    case 'openai':
      return {
        name: 'openai',
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL,
        model: env.OPENAI_MODEL,
      };
    case 'custom':
      return {
        name: 'custom',
        apiKey: env.AI_PROVIDER_API_KEY,
        baseURL: env.AI_PROVIDER_BASE_URL,
        model: env.AI_PROVIDER_MODEL,
      };
    case 'deepseek':
    default:
      return {
        name: 'deepseek',
        apiKey: env.DEEPSEEK_API_KEY,
        baseURL: env.DEEPSEEK_BASE_URL,
        model: env.DEEPSEEK_MODEL,
      };
  }
}
