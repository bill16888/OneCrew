import '../../setup';

/**
 * @file Tests for the pluggable provider resolver (Phase 1 Req 14).
 *
 * `resolveProvider()` maps the validated `AI_PROVIDER` selection onto
 * the concrete { apiKey, baseURL, model } the OpenAI-compatible client
 * is constructed with. These tests mock `@/lib/env` so each case can
 * pin a different provider without re-running the boot-time zod
 * validation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => {
  const mockEnv = {
    AI_PROVIDER: 'deepseek' as 'deepseek' | 'openai' | 'custom',
    DEEPSEEK_API_KEY: 'sk-deepseek',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: 'deepseek-chat',
    OPENAI_API_KEY: 'sk-openai',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL: 'gpt-4o-mini',
    AI_PROVIDER_API_KEY: 'sk-custom',
    AI_PROVIDER_BASE_URL: 'http://localhost:11434/v1',
    AI_PROVIDER_MODEL: 'llama3.1',
  };
  return { env: mockEnv, default: mockEnv };
});

import { env } from '@/lib/env';
import { resolveProvider } from '@/lib/ai/providers';

type MutableEnv = {
  AI_PROVIDER: 'deepseek' | 'openai' | 'custom';
};

afterEach(() => {
  (env as unknown as MutableEnv).AI_PROVIDER = 'deepseek';
});

describe('resolveProvider', () => {
  it('defaults to DeepSeek config', () => {
    (env as unknown as MutableEnv).AI_PROVIDER = 'deepseek';
    expect(resolveProvider()).toEqual({
      name: 'deepseek',
      apiKey: 'sk-deepseek',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
  });

  it('returns OpenAI config when AI_PROVIDER=openai', () => {
    (env as unknown as MutableEnv).AI_PROVIDER = 'openai';
    expect(resolveProvider()).toEqual({
      name: 'openai',
      apiKey: 'sk-openai',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
  });

  it('returns custom gateway config when AI_PROVIDER=custom', () => {
    (env as unknown as MutableEnv).AI_PROVIDER = 'custom';
    expect(resolveProvider()).toEqual({
      name: 'custom',
      apiKey: 'sk-custom',
      baseURL: 'http://localhost:11434/v1',
      model: 'llama3.1',
    });
  });

  it('all providers expose the same ProviderConfig shape', () => {
    for (const p of ['deepseek', 'openai', 'custom'] as const) {
      (env as unknown as MutableEnv).AI_PROVIDER = p;
      const config = resolveProvider();
      expect(config.name).toBe(p);
      expect(typeof config.apiKey).toBe('string');
      expect(config.baseURL).toMatch(/^https?:\/\//);
      expect(config.model.length).toBeGreaterThan(0);
    }
  });
});
