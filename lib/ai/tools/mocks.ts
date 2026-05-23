/**
 * @file Deterministic, in-memory implementations of the two read-only
 * mock tools the AI runtime exposes: `mock_web_search` and
 * `mock_read_project_docs`.
 *
 * Both functions are **pure**: same input → same output, every time.
 * They make zero outbound network calls (no `fetch`, no `axios`, no
 * dynamic imports of HTTP clients) and zero filesystem reads
 * (no `fs`, no `node:fs`, no `fs/promises`). Every byte they return is
 * baked into the frozen module-level constants below.
 *
 * The dispatcher in `lib/ai/tools/index.ts` routes tool calls here. The
 * helpers are exported as standalone pure functions so they can be
 * unit-tested and property-tested in isolation, and so Property 14
 * ("Mock 工具的纯净性" / mock tools' purity) can be verified without
 * booting the full runtime.
 *
 * Determinism rules enforced here:
 *  - No `Math.random()`.
 *  - No `Date.now()` / `new Date()`.
 *  - No I/O of any kind.
 *  - No closure state mutated between calls.
 *
 * Validates: Requirements 5.4 (Property 14: Mock 工具的纯净性).
 */

// ---------------------------------------------------------------------------
// Preset payloads (frozen so callers cannot mutate the cached strings)
// ---------------------------------------------------------------------------

/**
 * Three deterministic search-result rows used by every call to
 * {@link mockWebSearch}. Kept as a typed structure so the markdown
 * rendering below stays consistent if the rows are ever extended.
 */
const MOCK_WEB_SEARCH_RESULTS: ReadonlyArray<{
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}> = Object.freeze([
  Object.freeze({
    title: 'AI-Native Team Workspaces: A Practical Overview',
    url: 'https://example.com/ai-native-team-workspaces',
    snippet:
      'AI-native workspaces let human teammates and AI colleagues share the same channels, tasks, and approval flows in a single tool.',
  }),
  Object.freeze({
    title: 'Designing Agentic Loops with Bounded Autonomy',
    url: 'https://example.com/agentic-loops-bounded-autonomy',
    snippet:
      'Bounded agentic loops cap tool-use rounds and gate high-risk actions behind human approvals to keep autonomous agents predictable.',
  }),
  Object.freeze({
    title: 'Anthropic Tool Use: Multi-Round Patterns',
    url: 'https://example.com/anthropic-tool-use-patterns',
    snippet:
      'When the model returns tool_use blocks, the runtime must dispatch each call and write all tool_result blocks back into the next turn.',
  }),
]);

/**
 * Preset README body. Returned for any path whose lower-cased form
 * contains the substring `readme`.
 */
const MOCK_DOC_README: string = [
  '# AI-Native Team Workspace',
  '',
  'A single-workspace MVP where human teammates collaborate alongside two AI colleagues, Ada (engineer) and Hopper (project manager).',
  '',
  '## Highlights',
  '',
  '- Shared channels and a 4-column kanban board (Backlog / In Progress / In Review / Done).',
  '- AI colleagues operate via a bounded agentic loop with at most 5 tool-use rounds per cycle.',
  '- High-risk actions require a human approval before they run.',
].join('\n');

/**
 * Preset architecture overview. Returned for any path whose lower-cased
 * form contains the substring `architecture`.
 */
const MOCK_DOC_ARCHITECTURE: string = [
  '# Architecture Overview',
  '',
  'The platform runs in a single Node process started by `server.ts`, which hosts the Next.js HTTP server, the Socket.io realtime channel, and the agentic loop together.',
  '',
  '## Layers',
  '',
  '1. **Application layer** — Next.js App Router, React, Tailwind, shadcn/ui, Zustand.',
  '2. **Service layer** — Pure TypeScript modules under `lib/services/*` (channel, message, task, approval).',
  '3. **Runtime layer** — `lib/ai/*` (Anthropic SDK + tool dispatcher), `lib/realtime/*` (Socket.io + NextAuth guard), `lib/loop/*` (30s setInterval + EventEmitter wakeup).',
  '',
  'Realtime events are only broadcast after the corresponding service-layer write commits successfully.',
].join('\n');

/**
 * Default fallback body. Returned for any path that does not match a
 * known keyword. Echoing the path back makes the response useful as a
 * `tool_result` while staying fully deterministic.
 */
const MOCK_DOC_DEFAULT: string = [
  '# Project Notes',
  '',
  'No specific document matches that path in the mock registry, so this is the default placeholder.',
  '',
  '## Available preset docs',
  '',
  '- `README.md` — project overview.',
  '- `architecture.md` — high-level system architecture.',
  '',
  'Use one of those keywords in the requested path to load richer mock content.',
].join('\n');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a deterministic, human-readable markdown summary of preset
 * "search results" for the given query.
 *
 * Properties guaranteed by this function:
 *  - **Pure**: identical input always produces identical output.
 *  - **No network**: never calls `fetch`, `axios`, or any other HTTP
 *    client.
 *  - **No filesystem**: never imports or invokes `fs`, `node:fs`, or
 *    `fs/promises` (statically or dynamically).
 *  - **Non-empty**: always renders 3 preset result rows.
 *
 * The query string is echoed back in the heading so a downstream
 * `tool_result` carrying this text can be correlated with the
 * originating request without extra state.
 *
 * @param query Free-form search string from the model.
 * @returns A markdown string listing the preset results, e.g.
 * ```text
 * # Mock web search results
 * Query: "agentic patterns"
 *
 * 1. **AI-Native Team Workspaces…** — https://example.com/...
 *    AI-native workspaces let human teammates …
 * 2. ...
 * ```
 *
 * Validates: Requirements 5.4 (Property 14: Mock 工具的纯净性).
 */
export function mockWebSearch(query: string): string {
  const lines: string[] = [
    '# Mock web search results',
    `Query: ${JSON.stringify(query)}`,
    '',
  ];

  MOCK_WEB_SEARCH_RESULTS.forEach((result, index) => {
    lines.push(`${index + 1}. **${result.title}** — ${result.url}`);
    lines.push(`   ${result.snippet}`);
  });

  return lines.join('\n');
}

/**
 * Return deterministic preset markdown content for the given document
 * path. Routing is by case-insensitive keyword match against the path:
 *
 *  - Path contains `readme`         → README content.
 *  - Path contains `architecture`   → Architecture overview.
 *  - Anything else                  → Generic default placeholder.
 *
 * Properties guaranteed by this function:
 *  - **Pure**: identical input always produces identical output.
 *  - **No filesystem**: never imports or invokes `fs`, `node:fs`,
 *    `fs/promises`, or any other I/O module (statically or
 *    dynamically). The returned strings are baked into this module.
 *  - **No network**: never calls `fetch`.
 *
 * Examples:
 * ```ts
 * mockReadProjectDocs('README.md').startsWith('# AI-Native');         // true
 * mockReadProjectDocs('docs/architecture.md').includes('Layers');      // true
 * mockReadProjectDocs('does/not/exist.md').includes('default');        // true
 * ```
 *
 * @param path Document path requested by the AI.
 * @returns A markdown string carrying the matching preset content, or
 *          the default placeholder if no keyword matches.
 *
 * Validates: Requirements 5.4 (Property 14: Mock 工具的纯净性).
 */
export function mockReadProjectDocs(path: string): string {
  const needle = path.toLowerCase();

  if (needle.includes('readme')) {
    return MOCK_DOC_README;
  }

  if (needle.includes('architecture')) {
    return MOCK_DOC_ARCHITECTURE;
  }

  return MOCK_DOC_DEFAULT;
}
