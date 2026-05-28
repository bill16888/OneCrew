import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  parseCookieHeader,
  readChunkedCookie,
} from '@/lib/cookie-parser';

/**
 * Parser unit + property tests.
 *
 * Locks the contract documented in `lib/cookie-parser.ts`:
 *   - parseCookieHeader: RFC 6265 §5.4 quoted-value handling +
 *     percent-decoding + first-wins on duplicate names.
 *   - readChunkedCookie: numeric-suffix sort (so `.10` lands AFTER
 *     `.9`, not between `.1` and `.2`), tolerant of bare cookie +
 *     numbered cookies coexisting, ignores non-numeric suffixes.
 *
 * Validates: audit finding M4 (cookie parser hardening).
 */

describe('parseCookieHeader', () => {
  it('returns an empty object on empty / undefined input', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader([])).toEqual({});
  });

  it('parses a single cookie pair', () => {
    expect(parseCookieHeader('a=1')).toEqual({ a: '1' });
  });

  it('joins multiple Cookie headers when given an array', () => {
    expect(parseCookieHeader(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('strips a single pair of surrounding double quotes (RFC 6265)', () => {
    expect(parseCookieHeader('a="hello"')).toEqual({ a: 'hello' });
    // Inner quotes are preserved untouched.
    expect(parseCookieHeader('a="he"l"lo"')).toEqual({ a: 'he"l"lo' });
  });

  it('percent-decodes values', () => {
    expect(parseCookieHeader('a=hello%2Cworld')).toEqual({
      a: 'hello,world',
    });
  });

  it('skips malformed pairs without throwing', () => {
    // No `=`, leading separator, empty name → all silently dropped.
    expect(parseCookieHeader('; =empty; bad; a=1')).toEqual({ a: '1' });
  });

  it('keeps the first value when names repeat', () => {
    expect(parseCookieHeader('a=1; a=2')).toEqual({ a: '1' });
  });
});

describe('readChunkedCookie', () => {
  it('returns null when no chunk of the cookie exists', () => {
    expect(readChunkedCookie({ other: 'x' }, 'sess')).toBeNull();
  });

  it('returns a bare-named cookie unchanged', () => {
    expect(readChunkedCookie({ sess: 'abc' }, 'sess')).toBe('abc');
  });

  it('concatenates numbered chunks in numeric-suffix order', () => {
    // Insertion order intentionally jumbled to prove the sort fires.
    const cookies = {
      'sess.2': 'C',
      'sess.0': 'A',
      'sess.10': 'K',
      'sess.1': 'B',
      'sess.9': 'J',
    };
    expect(readChunkedCookie(cookies, 'sess')).toBe('ABCJK');
  });

  it('places the bare cookie BEFORE numbered chunks', () => {
    const cookies = {
      'sess.1': 'B',
      'sess.0': 'A',
      sess: 'PRE',
    };
    expect(readChunkedCookie(cookies, 'sess')).toBe('PREAB');
  });

  it('ignores non-numeric suffixes', () => {
    const cookies = {
      'sess.0': 'A',
      'sess.weird': 'IGNORED',
      'sess.1': 'B',
    };
    expect(readChunkedCookie(cookies, 'sess')).toBe('AB');
  });

  it('does not match unrelated cookies that share the prefix string', () => {
    // `session-token` would lexicographically appear to match `sess.`
    // but starts with `session-token`, not `sess.`. No match expected.
    expect(
      readChunkedCookie({ 'session-token': 'X', 'sess.0': 'A' }, 'sess'),
    ).toBe('A');
  });

  it('property: chunk insertion order does not affect result', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 100 }),
            fc.string({ minLength: 1, maxLength: 4 }),
          ),
          { minLength: 1, maxLength: 12 },
        ),
        (entries) => {
          // Build a unique-suffix map (later entries with same suffix
          // win, mirroring the upstream cookie semantics).
          const byIndex = new Map<number, string>();
          for (const [idx, val] of entries) byIndex.set(idx, val);

          // Two cookie maps with the same chunks but different
          // iteration order. Object literal property order is
          // deterministic for integer-like keys, so we use
          // string keys with a `.` prefix to keep insertion order.
          const ordered: Record<string, string> = {};
          for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
            ordered[`sess.${idx}`] = byIndex.get(idx)!;
          }
          const reversed: Record<string, string> = {};
          for (const idx of [...byIndex.keys()].sort((a, b) => b - a)) {
            reversed[`sess.${idx}`] = byIndex.get(idx)!;
          }

          const a = readChunkedCookie(ordered, 'sess');
          const b = readChunkedCookie(reversed, 'sess');
          expect(a).toBe(b);

          // And the result should match the manual numeric concat.
          const expected = [...byIndex.keys()]
            .sort((x, y) => x - y)
            .map((k) => byIndex.get(k)!)
            .join('');
          expect(a).toBe(expected);
        },
      ),
      { numRuns: 50 },
    );
  });
});
