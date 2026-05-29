/**
 * @file Tests for the shared `withSafeExecution` helper used by every
 * real tool to convert thrown errors / timeouts into the dispatcher's
 * `is_error: true` envelope shape.
 *
 * Validates: Phase 1 Req 12.4 (totality of real tools).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TOOL_TIMEOUT_MS,
  withSafeExecution,
} from '@/lib/ai/tools/with-safe-execution';

describe('withSafeExecution', () => {
  it('returns ok=true when fn resolves within the timeout', async () => {
    const result = await withSafeExecution({ toolName: 'demo' }, async () => 'hello');
    expect(result).toEqual({ ok: true, content: 'hello' });
  });

  it('returns ok=false with a safe message when fn throws', async () => {
    const result = await withSafeExecution({ toolName: 'demo' }, async () => {
      throw new Error('provider down');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.content).toContain('demo unavailable');
      expect(result.content).toContain('provider down');
    }
  });

  it('returns a timeout-specific message when AbortSignal fires', async () => {
    const result = await withSafeExecution(
      { toolName: 'demo', timeoutMs: 10 },
      async (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.content).toContain('demo timed out after 10ms');
    }
  });

  it('passes a live AbortSignal so HTTP clients can cancel', async () => {
    const seenSignal = vi.fn();
    const result = await withSafeExecution(
      { toolName: 'demo', timeoutMs: 5 },
      async (signal) => {
        seenSignal(signal instanceof AbortSignal);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled by signal')),
            { once: true },
          );
        });
      },
    );
    expect(seenSignal).toHaveBeenCalledWith(true);
    expect(result.ok).toBe(false);
  });

  it('clears the timer on success so the process can exit cleanly', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await withSafeExecution({ toolName: 'demo' }, async () => 'hi');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('exposes a sane default timeout', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(8_000);
  });
});
