import '../../setup';

/**
 * @file Tests for the knowledge-block assembly used by runtime
 * injection (Req 19.6-19.8). Targets the pure `buildKnowledgeBlock`
 * helper so the budget / omission logic is verified without running a
 * full cycle.
 */

import { describe, expect, it } from 'vitest';

import { buildKnowledgeBlock } from '@/lib/ai/runtime';

describe('buildKnowledgeBlock', () => {
  it('returns empty string when there are no cards', () => {
    expect(buildKnowledgeBlock([])).toBe('');
  });

  it('renders each card under the #channel heading', () => {
    const block = buildKnowledgeBlock([
      { name: 'engineering', knowledge: 'repo: x' },
      { name: 'general', knowledge: 'team: ada' },
    ]);
    expect(block).toContain('## 频道知识');
    expect(block).toContain('### #engineering');
    expect(block).toContain('repo: x');
    expect(block).toContain('### #general');
    expect(block).toContain('team: ada');
    expect(block).not.toContain('omitted');
  });

  it('omits cards beyond the budget with a marker', () => {
    // Each card ~6000 chars; the 12000 budget fits two, omits the rest.
    const big = 'x'.repeat(6000);
    const block = buildKnowledgeBlock([
      { name: 'a', knowledge: big },
      { name: 'b', knowledge: big },
      { name: 'c', knowledge: big },
      { name: 'd', knowledge: big },
    ]);
    expect(block).toContain('### #a');
    expect(block).toContain('more channel card(s) omitted');
    // d should not have made it in
    expect(block).not.toContain('### #d');
  });

  it('trims card content', () => {
    const block = buildKnowledgeBlock([
      { name: 'x', knowledge: '   padded   ' },
    ]);
    expect(block).toContain('### #x\npadded');
  });
});
