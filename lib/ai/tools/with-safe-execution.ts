/**
 * @file Shared "fail closed" helper for real (network-dependent) AI
 * tools. Wraps an async operation with a timeout + structured logging
 * + an `is_error`-friendly result envelope.
 *
 * Why this exists:
 * The MVP's `dispatchTool` already promises totality (Property 13):
 * it never throws, every failure becomes `tool_result { is_error: true }`.
 * Real tools added in Phase 1 (web_search, read_project_docs — Req 12)
 * each face the same set of failure modes (timeout, 4xx, 5xx, parse
 * error, missing API key). Centralising the wrap-and-log logic here
 * keeps every tool's branch identical in the dispatcher and makes the
 * 8-second timeout a single, audited number.
 *
 * Validates: Phase 1 Req 12.4.
 */

import { logger } from '@/lib/logger';

/**
 * Default network timeout for real tools. 8 s is generous enough for
 * cold-cache GitHub Contents lookups and search providers' deepest
 * search modes, but short enough that a stalled provider can't keep
 * a cycle's round occupied beyond the runtime's per-round budget.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 8_000;

/**
 * Result envelope returned by {@link withSafeExecution}.
 *
 * - `ok: true`  → the wrapped function resolved within the timeout
 *                 budget; `content` is the formatted output.
 * - `ok: false` → either the timeout elapsed, the function threw,
 *                 or the function returned an error sentinel; the
 *                 caller MUST translate this to `tool_result
 *                 { is_error: true, content }`.
 */
export type SafeExecutionResult =
  | { ok: true; content: string }
  | { ok: false; content: string };

interface SafeExecutionOptions {
  /** Tool name, used as the log event prefix. */
  readonly toolName: string;
  /** Custom timeout in ms; defaults to {@link DEFAULT_TOOL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Race the `fn` against a timer; return a typed envelope.
 *
 * Implementation notes:
 * - The timer is unref'd via `clearTimeout` on settle so a slow
 *   request can't keep the Node process alive past graceful
 *   shutdown.
 * - We pass an `AbortSignal` to the wrapped function so HTTP clients
 *   that support it (`fetch`, `undici`, `axios` with adapters) can
 *   cancel the in-flight request once we've already given up. Tools
 *   that ignore the signal still complete eventually but their
 *   result is discarded.
 * - The error message we surface back to the model is intentionally
 *   short (no stack traces, no provider-specific URLs) so the
 *   `tool_result` content stays under the model's attention budget.
 *   The full error including stack lands in pino + Sentry via
 *   `logger.warn`.
 */
export async function withSafeExecution(
  options: SafeExecutionOptions,
  fn: (signal: AbortSignal) => Promise<string>,
): Promise<SafeExecutionResult> {
  const { toolName, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const content = await fn(controller.signal);
    return { ok: true, content };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);

    logger.warn(
      {
        event: `${toolName}_failed`,
        aborted,
        err: message,
      },
      `${toolName} tool execution failed`,
    );

    if (aborted) {
      return {
        ok: false,
        content: `${toolName} timed out after ${timeoutMs}ms — try a narrower query or retry on the next round.`,
      };
    }
    return {
      ok: false,
      content: `${toolName} unavailable: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
