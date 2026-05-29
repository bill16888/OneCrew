/**
 * @file Tests for the real `read_project_docs` tool (GitHub Contents).
 *
 * Validates: Phase 1 Req 12.3, 12.4.
 */

import '../../../setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => {
  const mockEnv = {
    GITHUB_TOKEN: '',
    AI_DAILY_BUDGET_USD: 5,
  };
  return { env: mockEnv, default: mockEnv };
});

import { env } from '@/lib/env';
import {
  MAX_FILE_BYTES,
  readProjectDocs,
} from '@/lib/ai/tools/project-docs';

function fileResponse(content: string, size?: number): Response {
  return new Response(
    JSON.stringify({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(content, 'utf-8').toString('base64'),
      size: size ?? Buffer.byteLength(content, 'utf-8'),
      path: 'README.md',
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  (env as { GITHUB_TOKEN: string }).GITHUB_TOKEN = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readProjectDocs — file', () => {
  it('decodes a base64 file body and wraps it in a code fence', async () => {
    const fetchMock: typeof fetch = vi.fn(async () =>
      fileResponse('# Hello\nworld'),
    );
    const out = await readProjectDocs({
      owner: 'bill16888',
      repo: 'yubiao-workspace',
      path: 'README.md',
      fetchImpl: fetchMock,
    });
    expect(out).toContain('# File: bill16888/yubiao-workspace/README.md');
    expect(out).toContain('# Hello');
    expect(out).toContain('world');
    expect(out).toContain('```');
  });

  it('builds the correct Contents API URL with ref', async () => {
    const fetchMock: typeof fetch = vi.fn(async () => fileResponse('x'));
    await readProjectDocs({
      owner: 'o',
      repo: 'r',
      path: 'src/index.ts',
      ref: 'develop',
      fetchImpl: fetchMock,
    });
    const url = (fetchMock as unknown as { mock: { calls: string[][] } }).mock
      .calls[0][0];
    expect(url).toBe(
      'https://api.github.com/repos/o/r/contents/src/index.ts?ref=develop',
    );
  });

  it('sends Authorization when GITHUB_TOKEN is set', async () => {
    (env as { GITHUB_TOKEN: string }).GITHUB_TOKEN = 'ghp_secret';
    const fetchMock: typeof fetch = vi.fn(async () => fileResponse('x'));
    await readProjectDocs({
      owner: 'o',
      repo: 'r',
      path: 'f',
      fetchImpl: fetchMock,
    });
    const init = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_secret');
  });

  it('omits Authorization when no token configured', async () => {
    const fetchMock: typeof fetch = vi.fn(async () => fileResponse('x'));
    await readProjectDocs({
      owner: 'o',
      repo: 'r',
      path: 'f',
      fetchImpl: fetchMock,
    });
    const init = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('truncates files larger than the 64KB cap with a marker', async () => {
    const big = 'a'.repeat(MAX_FILE_BYTES + 5_000);
    const fetchMock: typeof fetch = vi.fn(async () =>
      fileResponse(big, MAX_FILE_BYTES + 5_000),
    );
    const out = await readProjectDocs({
      owner: 'o',
      repo: 'r',
      path: 'big.txt',
      fetchImpl: fetchMock,
    });
    expect(out).toContain('truncated to');
    // The decoded body inside the fence must not exceed the cap. We
    // extract the run of 'a' characters (the actual file content)
    // rather than the whole fenced block, which also contains the
    // header line and surrounding newlines.
    const bodyMatch = out.match(/a+/);
    expect(bodyMatch).not.toBeNull();
    expect(Buffer.byteLength(bodyMatch![0], 'utf-8')).toBeLessThanOrEqual(
      MAX_FILE_BYTES,
    );
  });
});

describe('readProjectDocs — directory', () => {
  it('renders a markdown listing for directory responses', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 100 },
            { name: 'lib', path: 'src/lib', type: 'dir', size: 0 },
          ]),
          { status: 200 },
        ),
    );
    const out = await readProjectDocs({
      owner: 'o',
      repo: 'r',
      path: 'src',
      fetchImpl: fetchMock,
    });
    expect(out).toContain('# Directory: o/r/src');
    expect(out).toContain('index.ts');
    expect(out).toContain('lib');
    expect(out).toContain('(100 bytes)');
  });
});

describe('readProjectDocs — errors (Req 12.4)', () => {
  it('throws a clear message on 404', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () => new Response('not found', { status: 404 }),
    );
    await expect(
      readProjectDocs({
        owner: 'o',
        repo: 'r',
        path: 'missing',
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow('Not found');
  });

  it('detects rate-limit (403 + x-ratelimit-remaining: 0)', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response('rate limited', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
    );
    await expect(
      readProjectDocs({
        owner: 'o',
        repo: 'r',
        path: 'f',
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow('rate limit exceeded');
  });

  it('distinguishes a permission 403 from rate-limit', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response('forbidden', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '4999' },
        }),
    );
    await expect(
      readProjectDocs({
        owner: 'o',
        repo: 'r',
        path: 'f',
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow('Access denied');
  });

  it('throws on other non-2xx statuses', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    );
    await expect(
      readProjectDocs({
        owner: 'o',
        repo: 'r',
        path: 'f',
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow('GitHub HTTP 500');
  });

  it('strips path traversal segments before building the URL', async () => {
    const fetchMock: typeof fetch = vi.fn(async () => fileResponse('x'));
    await readProjectDocs({
      owner: 'o',
      repo: 'r',
      path: '../../etc/passwd',
      fetchImpl: fetchMock,
    });
    const url = (fetchMock as unknown as { mock: { calls: string[][] } }).mock
      .calls[0][0];
    // ".." segments removed → "etc/passwd"
    expect(url).toBe('https://api.github.com/repos/o/r/contents/etc/passwd');
  });
});
