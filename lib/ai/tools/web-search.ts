/**
 * @file Real (network-dependent) `web_search` tool implementation.
 *
 * Phase 1 Req 12.2: AIs read live information from the public web
 * via a configured search provider. Two adapters ship in this
 * module:
 *
 *  - **Tavily** (`https://api.tavily.com/search`) — purpose-built
 *    for AI agents, returns ranked results with title/url/snippet.
 *    Default. Free tier (1000 queries / month) is enough for solo
 *    operators.
 *  - **Serper** (`https://google.serper.dev/search`) — Google SERP
 *    wrapper. Used as fallback when Tavily is unavailable.
 *
 * Both adapters return the same `SearchResult[]` shape so the
 * dispatcher branch in `lib/ai/tools/index.ts` stays identical
 * regardless of provider.
 *
 * The function `webSearch(query, options)` is the only public
 * surface; the dispatcher calls it through `withSafeExecution`
 * (`lib/ai/tools/with-safe-execution.ts`) which enforces the 8 s
 * timeout and the is_error envelope (Req 12.4).
 *
 * Test layering:
 * - `searchTavily` / `searchSerper` are exported for adapter-level
 *   tests with a mocked `fetch` injection.
 * - `webSearch` is the integrating function used by the dispatcher.
 *
 * Validates: Phase 1 Req 12.2, 12.4, 12.5, 12.6.
 */

import { env } from '@/lib/env';

/** Single normalised search result row. */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Options accepted by {@link webSearch}. */
export interface WebSearchOptions {
  /** Caller-supplied cap on rendered rows. Clamped to `[1, 10]`. */
  readonly maxResults?: number;
  /**
   * Optional `fetch` injection used by tests. Production code passes
   * the global `fetch`; tests pass a deterministic mock.
   */
  readonly fetchImpl?: typeof fetch;
  /** Optional AbortSignal; wired by `withSafeExecution`. */
  readonly signal?: AbortSignal;
}

/**
 * Hard upper bound on returned rows. The model rarely benefits from
 * more than ~5; bigger windows just chew through context.
 */
const MAX_RESULTS_HARD_CAP = 10;

/**
 * Tavily adapter.
 *
 * Endpoint: `POST https://api.tavily.com/search`
 *
 * Request shape (relevant subset):
 * ```json
 * { "api_key": "<TAVILY_API_KEY>", "query": "...", "max_results": 5,
 *   "search_depth": "basic" }
 * ```
 *
 * Response shape (relevant subset):
 * ```json
 * { "results": [{ "title": "...", "url": "...", "content": "..." }, ...] }
 * ```
 *
 * Tavily returns `content` (not `snippet`). We rename in the
 * normalisation step so the dispatcher's markdown renderer can stay
 * provider-agnostic.
 */
export async function searchTavily(
  query: string,
  options: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not configured');
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const limit = clampMaxResults(options.maxResults);

  const response = await fetchFn('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      search_depth: 'basic',
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  if (!Array.isArray(data.results)) {
    throw new Error('Tavily response missing results array');
  }

  return data.results
    .filter(
      (r): r is { title: string; url: string; content: string } =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as { title?: unknown }).title === 'string' &&
        typeof (r as { url?: unknown }).url === 'string' &&
        typeof (r as { content?: unknown }).content === 'string',
    )
    .slice(0, limit)
    .map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

/**
 * Serper adapter.
 *
 * Endpoint: `POST https://google.serper.dev/search`
 *
 * Response shape (relevant subset):
 * ```json
 * { "organic": [{ "title": "...", "link": "...", "snippet": "..." }, ...] }
 * ```
 */
export async function searchSerper(
  query: string,
  options: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = env.SERPER_API_KEY;
  if (!apiKey) {
    throw new Error('SERPER_API_KEY is not configured');
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const limit = clampMaxResults(options.maxResults);

  const response = await fetchFn('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    signal: options.signal,
    body: JSON.stringify({ q: query, num: limit }),
  });

  if (!response.ok) {
    throw new Error(`Serper HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  if (!Array.isArray(data.organic)) {
    throw new Error('Serper response missing organic array');
  }

  return data.organic
    .filter(
      (r): r is { title: string; link: string; snippet: string } =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as { title?: unknown }).title === 'string' &&
        typeof (r as { link?: unknown }).link === 'string' &&
        typeof (r as { snippet?: unknown }).snippet === 'string',
    )
    .slice(0, limit)
    .map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
}

/**
 * Front-end the dispatcher calls. Selects the configured provider,
 * forwards the request, and returns the normalised results.
 *
 * Throws on adapter-level failures — the caller (the dispatcher,
 * via {@link withSafeExecution}) is responsible for converting these
 * to `tool_result { is_error: true }`.
 */
export async function webSearch(
  query: string,
  options: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const provider = env.WEB_SEARCH_PROVIDER;
  switch (provider) {
    case 'serper':
      return searchSerper(query, options);
    case 'tavily':
    default:
      return searchTavily(query, options);
  }
}

/**
 * Render `SearchResult[]` as a model-readable markdown block.
 *
 * Format mirrors the existing `mockWebSearch` output so existing
 * AI prompts that expect that shape don't need re-tuning when an
 * operator switches from `mock_web_search` → `web_search`.
 */
export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return [
      '# Web search results',
      `Query: ${JSON.stringify(query)}`,
      '',
      '(no results)',
    ].join('\n');
  }

  const lines: string[] = [
    '# Web search results',
    `Query: ${JSON.stringify(query)}`,
    '',
  ];
  results.forEach((r, index) => {
    lines.push(`${index + 1}. **${r.title}** — ${r.url}`);
    lines.push(`   ${r.snippet}`);
  });
  return lines.join('\n');
}

function clampMaxResults(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 5;
  return Math.min(MAX_RESULTS_HARD_CAP, Math.max(1, Math.floor(value)));
}
