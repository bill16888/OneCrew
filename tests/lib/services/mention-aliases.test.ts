import '../../setup';

/**
 * @file Tests for `aiMatchesMentions` — the @-mention matching
 * contract after brand decoupling (Phase 1 Req 16.2).
 *
 * The behavioural change under test: the runtime no longer carries a
 * hard-coded Ada→艾达 / Hopper→霍珀 alias table. Aliases come purely
 * from each AI's `aiSettings.mentionAliases` (populated by the seed
 * from `AI_AGENT_NAMES_JSON`). These tests lock that contract:
 *   - the AI's own name always matches (case-insensitive),
 *   - configured aliases match,
 *   - a transliteration that is NOT in aiSettings does NOT match
 *     (proving the hard-coded brand table is gone),
 *   - malformed / missing aiSettings degrades to name-only matching.
 */

import { describe, expect, it } from 'vitest';

import { aiMatchesMentions } from '@/lib/services/message.service';

function mentionSet(...tokens: string[]): ReadonlySet<string> {
  return new Set(tokens.map((t) => t.toLowerCase()));
}

describe('aiMatchesMentions — name matching', () => {
  it('matches the AI name case-insensitively', () => {
    expect(aiMatchesMentions('Architect', null, mentionSet('architect'))).toBe(
      true,
    );
    expect(aiMatchesMentions('Architect', null, mentionSet('ARCHITECT'))).toBe(
      true,
    );
  });

  it('does not match an unrelated mention', () => {
    expect(
      aiMatchesMentions('Architect', null, mentionSet('coordinator')),
    ).toBe(false);
  });
});

describe('aiMatchesMentions — aliases come from aiSettings', () => {
  it('matches a configured alias', () => {
    const settings = { mentionAliases: ['架构师', 'arch'] };
    expect(aiMatchesMentions('Architect', settings, mentionSet('架构师'))).toBe(
      true,
    );
    expect(aiMatchesMentions('Architect', settings, mentionSet('arch'))).toBe(
      true,
    );
  });

  it('does NOT match a transliteration absent from aiSettings (no hard-coded brand table)', () => {
    // Pre-decoupling, "艾达" would have matched an AI named "Ada" via
    // the hard-coded MENTION_ALIASES table. After Req 16.2 that table
    // is gone — an AI named Ada with NO mentionAliases must not match
    // 艾达.
    expect(aiMatchesMentions('Ada', null, mentionSet('艾达'))).toBe(false);
    expect(
      aiMatchesMentions('Ada', { mentionAliases: [] }, mentionSet('艾达')),
    ).toBe(false);
  });

  it('matches 艾达 only when aiSettings explicitly lists it', () => {
    const settings = { mentionAliases: ['艾达', '阿达'] };
    expect(aiMatchesMentions('Ada', settings, mentionSet('艾达'))).toBe(true);
  });
});

describe('aiMatchesMentions — robustness', () => {
  it('ignores non-string / malformed aiSettings and falls back to name', () => {
    expect(aiMatchesMentions('Architect', undefined, mentionSet('architect'))).toBe(
      true,
    );
    expect(aiMatchesMentions('Architect', 'not-an-object', mentionSet('architect'))).toBe(
      true,
    );
    expect(
      aiMatchesMentions('Architect', { mentionAliases: 'nope' }, mentionSet('架构师')),
    ).toBe(false);
  });

  it('filters out non-string and blank alias entries', () => {
    const settings = { mentionAliases: ['  spaced  ', '', 42, null, '架构师'] };
    // 'spaced' is trimmed + lowercased; blank/non-string dropped.
    expect(aiMatchesMentions('X', settings, mentionSet('spaced'))).toBe(true);
    expect(aiMatchesMentions('X', settings, mentionSet('架构师'))).toBe(true);
    expect(aiMatchesMentions('X', settings, mentionSet(''))).toBe(false);
  });
});
