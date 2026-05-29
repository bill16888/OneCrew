/**
 * @file Real `read_project_docs` tool — reads a file (or lists a
 * directory) from a public/private GitHub repository via the GitHub
 * Contents API.
 *
 * Phase 1 Req 12.3: AIs read source / docs straight from the
 * operator's repositories so their suggestions reflect the actual
 * code, not a guess. The mock variant (`mock_read_project_docs`)
 * stays in the surface for offline / test mode (Property 14).
 *
 * Auth strategy (Req 12.3):
 *  1. If `GITHUB_TOKEN` is set → send `Authorization: Bearer <token>`
 *     (PAT or Actions token; 5000 req/h, can read private repos the
 *     token has access to).
 *  2. Otherwise → anonymous (60 req/h shared rate limit, public repos
 *     only).
 *
 * Response handling:
 *  - file → base64-decode, return UTF-8 body capped at 64 KB
 *    (Req 12.3). Over-cap files return a truncation marker so the AI
 *    knows to refine the path or request a range.
 *  - directory → markdown list of entries with their types so the AI
 *    can drill down on the next call.
 *  - 404 / 403 / rate-limit → thrown Error; the dispatcher's
 *    `withSafeExecution` wrapper converts it to `is_error: true`
 *    (Req 12.4). This module never returns the error envelope itself;
 *    it throws and lets the shared wrapper format the result.
 *
 * Validates: Phase 1 Req 12.3, 12.4, 12.5.
 */

import { env } from '@/lib/env';

/** 64 KB cap on returned file bodies (Req 12.3). */
export const MAX_FILE_BYTES = 64 * 1024;

/** Input accepted by {@link readProjectDocs}. */
export interface ReadProjectDocsInput {
  readonly owner: string;
  readonly repo: string;
  readonly path: string;
  /** Branch / tag / commit SHA. Defaults to the repo's default branch. */
  readonly ref?: string;
  /** Optional `fetch` injection for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Optional AbortSignal; wired by `withSafeExecution`. */
  readonly signal?: AbortSignal;
}

/** A single entry when the requested path resolves to a directory. */
interface GitHubDirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
}

/** GitHub Contents API file response (relevant subset). */
interface GitHubFileResponse {
  type: 'file';
  encoding: 'base64' | string;
  content: string;
  size: number;
  path: string;
}

/**
 * Build the request headers. Always sends the GitHub API version +
 * a User-Agent (GitHub rejects requests without one). Adds the
 * Authorization header only when a token is configured.
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'yubiao-workspace-ai',
  };
  const token = env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Sanitise a caller-supplied path segment so it can't break out of
 * the Contents API route (`..`, leading slash, etc.). GitHub itself
 * rejects most traversal but we normalise defensively so error
 * messages stay clean and we never issue a surprising URL.
 */
function normalizePath(path: string): string {
  return path
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * Read a file or list a directory from GitHub.
 *
 * Throws on any non-2xx response, missing fields, or oversize-without-
 * truncation-marker conditions. The dispatcher's `withSafeExecution`
 * wrapper turns thrown errors into `tool_result { is_error: true }`.
 *
 * @returns Markdown-formatted content ready to hand back to the model.
 */
export async function readProjectDocs(
  input: ReadProjectDocsInput,
): Promise<string> {
  const fetchFn = input.fetchImpl ?? fetch;
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const cleanPath = normalizePath(input.path);
  const refQuery = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : '';

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}${refQuery}`;

  const response = await fetchFn(url, {
    method: 'GET',
    headers: buildHeaders(),
    signal: input.signal,
  });

  if (response.status === 404) {
    throw new Error(
      `Not found: ${input.owner}/${input.repo}/${cleanPath}${
        input.ref ? ` @ ${input.ref}` : ''
      }. Check the path and ref.`,
    );
  }
  if (response.status === 403) {
    // 403 is GitHub's rate-limit signal as well as a permission denial.
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      throw new Error(
        'GitHub API rate limit exceeded. Set GITHUB_TOKEN for a higher limit, or retry later.',
      );
    }
    throw new Error(
      `Access denied to ${input.owner}/${input.repo}. The repo may be private; set GITHUB_TOKEN with access.`,
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub HTTP ${response.status}`);
  }

  const data = (await response.json()) as
    | GitHubFileResponse
    | GitHubDirEntry[];

  // Directory listing: the Contents API returns an array.
  if (Array.isArray(data)) {
    return formatDirectory(input, data);
  }

  // File: decode base64 content, cap at MAX_FILE_BYTES.
  if (data.type === 'file' && typeof data.content === 'string') {
    return formatFile(input, data);
  }

  throw new Error(
    `Unsupported content type at ${cleanPath} (got "${
      (data as { type?: string }).type ?? 'unknown'
    }").`,
  );
}

function formatDirectory(
  input: ReadProjectDocsInput,
  entries: GitHubDirEntry[],
): string {
  const header = `# Directory: ${input.owner}/${input.repo}/${normalizePath(
    input.path,
  )}`;
  if (entries.length === 0) {
    return `${header}\n\n(empty directory)`;
  }
  const lines = entries
    .slice(0, 200)
    .map((e) => {
      const marker = e.type === 'dir' ? '📁' : '📄';
      const sizeNote = e.type === 'file' ? ` (${e.size} bytes)` : '';
      return `- ${marker} ${e.name}${sizeNote}`;
    });
  const truncated =
    entries.length > 200
      ? `\n\n…and ${entries.length - 200} more entries (refine the path).`
      : '';
  return `${header}\n\n${lines.join('\n')}${truncated}`;
}

function formatFile(
  input: ReadProjectDocsInput,
  data: GitHubFileResponse,
): string {
  const header = `# File: ${input.owner}/${input.repo}/${data.path}${
    input.ref ? ` @ ${input.ref}` : ''
  }`;

  // The Contents API base64-encodes the body (with embedded newlines).
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8');

  if (Buffer.byteLength(decoded, 'utf-8') > MAX_FILE_BYTES) {
    const truncated = sliceToByteLimit(decoded, MAX_FILE_BYTES);
    return [
      header,
      `(truncated to ${MAX_FILE_BYTES} bytes — full file is ${data.size} bytes;`,
      ' request a more specific path or a sub-range if you need the rest)',
      '',
      '```',
      truncated,
      '```',
    ].join('\n');
  }

  return [header, '', '```', decoded, '```'].join('\n');
}

/**
 * Slice a UTF-8 string to at most `limit` bytes without splitting a
 * multi-byte character in half. We walk back from the byte boundary
 * until the slice is valid UTF-8.
 */
function sliceToByteLimit(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= limit) return text;
  let end = limit;
  // Back off until we're not in the middle of a multi-byte sequence
  // (continuation bytes are 0b10xxxxxx == 0x80..0xBF).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf-8');
}
