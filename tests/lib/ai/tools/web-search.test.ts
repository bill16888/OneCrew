/**
 * @file Adapter + integration tests for the real `web_search` tool.
 *
 * Validates: Phase 1 Req 12.2, 12.4, 12.6.
 */

import '../../../setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env BEFORE importing the modules under test. The Tavily / Serper
// adapters read env keys at call time so this needs to be in place
// before any import resolution.
vi.mock('@/lib/env', () => {
  const mockEnv = {
    TAVILY_API_KEY: 'test-tavily-key',
    SERPER_API_KEY: 'test-serper-key',
    WEB_SEARCH_PROVIDER: 'tavily' as 'tavily' | 'serper',
    WEB_SEARCH_COST_USD: 0.001,
    AI_DAILY_BUDGET_USD: 5,
    AI_INPUT_PRICE_PER_M_USD: 1.07,
    AI_OUTPUT_PRICE_PER_M_USD: 1.1,
  };
  return { env: mockEnv, default: mockEnv };
});

import { env } from '@/lib/env';
import {
  formatResults,
  searchSerper,
  searchTavily,
  webSearch,
  type SearchResult,
} from '@/lib/ai/tools/web-search';

beforeEach(() => {
  // Reset to default provider before each test; individual tests
  // override as needed.
  (env as { WEB_SEARCH_PROVIDER: 'tavily' | 'serper' }).WEB_SEARCH_PROVIDER =
    'tavily';
  (env as { TAVILY_API_KEY: string }).TAVILY_API_KEY = 'test-tavily-key';
  (env as { SERPER_API_KEY: string }).SERPER_API_KEY = 'test-serper-key';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchTavily', () => {
  it('issues POST to api.tavily.com/search and normalises the response', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: 'AI tools 2026',
                url: 'https://example.com/a',
                content: 'snippet a',
              },
              {
                title: 'Why agents matter',
                url: 'https://example.com/b',
                content: 'snippet b',
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const results = await searchTavily('agents', { fetchImpl: fetchMock });

    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const [calledUrl, calledInit] = calls[0];
    expect(calledUrl).toBe('https://api.tavily.com/search');
    expect(calledInit?.method).toBe('POST');
    const body = JSON.parse((calledInit?.body as string) ?? '{}');
    expect(body.query).toBe('agents');
    expect(body.api_key).toBe('test-tavily-key');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'AI tools 2026',
      url: 'https://example.com/a',
      snippet: 'snippet a',
    });
  });

  it('throws on non-2xx so the dispatcher surfaces is_error', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    );
    await expect(
      searchTavily('q', { fetchImpl: fetchMock }),
    ).rejects.toThrow('Tavily HTTP 429');
  });

  it('throws when API key is missing', async () => {
    (env as { TAVILY_API_KEY: string }).TAVILY_API_KEY = '';
    await expect(searchTavily('q')).rejects.toThrow('TAVILY_API_KEY');
  });

  it('clamps maxResults to [1, 10]', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async (_url, init?) => {
        const body = JSON.parse((init?.body as string) ?? '{}');
        return new Response(
          JSON.stringify({
            results: Array.from({ length: body.max_results }, (_, i) => ({
              title: `t${i}`,
              url: `https://x/${i}`,
              content: `s${i}`,
            })),
          }),
          { status: 200 },
        );
      },
    );

    const tooMany = await searchTavily('q', {
      fetchImpl: fetchMock,
      maxResults: 999,
    });
    expect(tooMany).toHaveLength(10);

    const tooFew = await searchTavily('q', {
      fetchImpl: fetchMock,
      maxResults: 0,
    });
    expect(tooFew).toHaveLength(1);
  });

  it('drops malformed result rows instead of throwing', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: 'good', url: 'https://x', content: 'ok' },
              { title: 'no url', content: 'half' }, // missing url
              null,
              { title: 'bad-content', url: 'https://x', content: 42 }, // bad type
            ],
          }),
          { status: 200 },
        ),
    );

    const results = await searchTavily('q', { fetchImpl: fetchMock });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('good');
  });

  it('throws when results array is missing entirely', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(
      searchTavily('q', { fetchImpl: fetchMock }),
    ).rejects.toThrow('Tavily response missing results array');
  });
});

describe('searchSerper', () => {
  it('issues POST with the X-API-KEY header and reads `organic`', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async (_url, init?) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers['X-API-KEY']).toBe('test-serper-key');
        return new Response(
          JSON.stringify({
            organic: [
              { title: 'Hit', link: 'https://example.com', snippet: 'snip' },
            ],
          }),
          { status: 200 },
        );
      },
    );

    const results = await searchSerper('agents', { fetchImpl: fetchMock });
    expect(results).toEqual([
      { title: 'Hit', url: 'https://example.com', snippet: 'snip' },
    ]);
  });
});

describe('webSearch (provider selection)', () => {
  it('routes to Tavily by default', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [{ title: 't', url: 'https://x', content: 's' }],
          }),
          { status: 200 },
        ),
    );

    const results = await webSearch('q', { fetchImpl: fetchMock });
    expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(
      'https://api.tavily.com/search',
    );
    expect(results).toHaveLength(1);
  });

  it('routes to Serper when WEB_SEARCH_PROVIDER=serper', async () => {
    (env as { WEB_SEARCH_PROVIDER: 'tavily' | 'serper' }).WEB_SEARCH_PROVIDER =
      'serper';
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            organic: [{ title: 't', link: 'https://x', snippet: 's' }],
          }),
          { status: 200 },
        ),
    );

    await webSearch('q', { fetchImpl: fetchMock });
    expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(
      'https://google.serper.dev/search',
    );
  });
});

describe('formatResults', () => {
  it('renders an empty-state placeholder when results is empty', () => {
    const md = formatResults('agents', []);
    expect(md).toContain('Query: "agents"');
    expect(md).toContain('(no results)');
  });

  it('renders one numbered list entry per result', () => {
    const rows: SearchResult[] = [
      { title: 'A', url: 'https://a', snippet: 'snip-a' },
      { title: 'B', url: 'https://b', snippet: 'snip-b' },
    ];
    const md = formatResults('q', rows);
    expect(md).toContain('1. **A** — https://a');
    expect(md).toContain('2. **B** — https://b');
    expect(md).toContain('snip-a');
    expect(md).toContain('snip-b');
  });
});
