/**
 * @file Lightweight RFC 6265 cookie parser used by the Socket.io
 * handshake middleware (`lib/realtime/io.ts`).
 *
 * History: NextAuth 4 splits large session JWTs into numbered cookie
 * chunks (`__Secure-next-auth.session-token.0`,
 * `__Secure-next-auth.session-token.1`, …). The Socket.io handshake
 * receives a plain `IncomingMessage` whose `headers.cookie` is a
 * single header value, and the original `getToken()` integration
 * cannot decode chunked tokens out of that path on its own. We need
 * to parse the cookie header ourselves, sort chunks by their numeric
 * suffix, and concatenate them before handing the result back to
 * `next-auth/jwt → decode`.
 *
 * The audit (M4) flagged the original handwritten parser as fragile.
 * This module is the hardened replacement:
 *
 *   - {@link parseCookieHeader} follows RFC 6265 §5.2 ordering and
 *     §5.4 quoted-value semantics (strip a single pair of surrounding
 *     double quotes when present).
 *   - {@link readChunkedCookie} sorts chunks by parsed integer suffix
 *     (so `.10` lands AFTER `.9`, not lexicographically between `.1`
 *     and `.2`), tolerates missing chunks, and ignores bogus suffixes.
 *
 * Both helpers are pure / deterministic so they are exercised by
 * property-based tests in `tests/lib/cookie-parser.test.ts`.
 *
 * Validates: closes audit finding M4 (cookie parser hardening; the
 * full NextAuth 5 migration is intentionally deferred).
 */

/**
 * Parse a `Cookie` header (or its array form, when the runtime exposes
 * it that way) into a `name → value` map.
 *
 * Behaviour:
 *   - Multiple `Cookie` headers are joined with `'; '` before parsing.
 *   - Pairs without an `=` are skipped silently.
 *   - Names are trimmed; values are trimmed and percent-decoded
 *     (`%2C` → `,`).
 *   - Values surrounded by a single pair of double quotes have the
 *     quotes stripped (RFC 6265 §5.4 / §4.1.1).
 *   - Pairs whose names repeat keep the *first* value. The MVP never
 *     emits duplicate-name cookies, so the order is academic; we pin
 *     it for determinism.
 *
 * Always returns a plain object. Never throws.
 */
export function parseCookieHeader(
  header: string | readonly string[] | undefined,
): Record<string, string> {
  if (header === undefined) return {};
  const flat = Array.isArray(header) ? header.join('; ') : (header as string);
  if (flat.length === 0) return {};

  const cookies: Record<string, string> = {};
  for (const pair of flat.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = pair.slice(0, separatorIndex).trim();
    if (name.length === 0) continue;
    if (Object.prototype.hasOwnProperty.call(cookies, name)) continue;

    let rawValue = pair.slice(separatorIndex + 1).trim();
    // Strip a single pair of surrounding double quotes so callers see
    // the same value the browser intended to send (RFC 6265 §5.4).
    if (
      rawValue.length >= 2 &&
      rawValue.startsWith('"') &&
      rawValue.endsWith('"')
    ) {
      rawValue = rawValue.slice(1, -1);
    }
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

/**
 * Read the value of a cookie that NextAuth may have split into
 * numbered chunks (`<name>`, `<name>.0`, `<name>.1`, …). Returns the
 * concatenated chunk values in numeric-suffix order, or `null` when
 * no chunk of the cookie is present.
 *
 * Sort key:
 *   - Bare `<name>` (no suffix) → `-1` so it lands BEFORE any numbered
 *     chunk. NextAuth uses the bare cookie for tokens small enough to
 *     fit in a single 4 KB cookie; a numbered chunk only appears when
 *     the JWT is too large for one entry.
 *   - `<name>.N` where `N` parses as a non-negative integer → that
 *     integer.
 *   - Anything else (suffix is non-numeric) → ignored.
 */
export function readChunkedCookie(
  cookies: Record<string, string>,
  cookieName: string,
): string | null {
  const prefix = `${cookieName}.`;
  const ordered: Array<{ index: number; value: string }> = [];

  for (const [name, value] of Object.entries(cookies)) {
    if (name === cookieName) {
      ordered.push({ index: -1, value });
      continue;
    }
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue; // ignore bogus / non-numeric suffixes
    ordered.push({ index: Number.parseInt(suffix, 10), value });
  }

  if (ordered.length === 0) return null;
  ordered.sort((a, b) => a.index - b.index);
  return ordered.map((entry) => entry.value).join('');
}
