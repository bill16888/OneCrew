import '../../setup';

/**
 * @file Tests for channel knowledge cards (Req 19).
 *
 * Covers the service-layer cap + clear behaviour and the member-scoped
 * batch read used by runtime injection. Prisma is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  updated: { content: null as string | null },
  channelRow: { knowledge: null as string | null },
  memberChannels: [] as Array<{ name: string; knowledge: string | null }>,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    channel: {
      findUnique: vi.fn(async () => ({ knowledge: hoisted.channelRow.knowledge })),
      update: vi.fn(async (args: { data: { knowledge: string } }) => {
        hoisted.updated.content = args.data.knowledge;
        return {};
      }),
      findMany: vi.fn(async () => hoisted.memberChannels),
    },
  },
}));

import {
  ChannelService,
  KNOWLEDGE_MAX_LENGTH,
  KnowledgeValidationError,
} from '@/lib/services/channel.service';

beforeEach(() => {
  hoisted.updated.content = null;
  hoisted.channelRow.knowledge = null;
  hoisted.memberChannels = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChannelService.getKnowledge', () => {
  it('returns the stored card', async () => {
    hoisted.channelRow.knowledge = '## Project\nrepo: x';
    expect(await ChannelService.getKnowledge('c1')).toBe('## Project\nrepo: x');
  });

  it('returns null when unset', async () => {
    hoisted.channelRow.knowledge = null;
    expect(await ChannelService.getKnowledge('c1')).toBeNull();
  });
});

describe('ChannelService.setKnowledge', () => {
  it('persists content within the cap', async () => {
    await ChannelService.setKnowledge('c1', 'hello');
    expect(hoisted.updated.content).toBe('hello');
  });

  it('allows an empty string (clears the card)', async () => {
    await ChannelService.setKnowledge('c1', '');
    expect(hoisted.updated.content).toBe('');
  });

  it('rejects content over the cap without persisting', async () => {
    const tooLong = 'a'.repeat(KNOWLEDGE_MAX_LENGTH + 1);
    await expect(ChannelService.setKnowledge('c1', tooLong)).rejects.toBeInstanceOf(
      KnowledgeValidationError,
    );
    expect(hoisted.updated.content).toBeNull(); // nothing written
  });

  it('accepts content exactly at the cap', async () => {
    const atCap = 'a'.repeat(KNOWLEDGE_MAX_LENGTH);
    await ChannelService.setKnowledge('c1', atCap);
    expect(hoisted.updated.content).toBe(atCap);
  });
});

describe('ChannelService.getKnowledgeForMemberChannels', () => {
  it('returns only channels with non-empty knowledge', async () => {
    hoisted.memberChannels = [
      { name: 'engineering', knowledge: 'repo: x' },
      { name: 'blank', knowledge: '   ' }, // whitespace-only → dropped
      { name: 'general', knowledge: 'team: ada' },
    ];
    const result = await ChannelService.getKnowledgeForMemberChannels(
      'ws_default',
      'ai_1',
    );
    expect(result).toEqual([
      { name: 'engineering', knowledge: 'repo: x' },
      { name: 'general', knowledge: 'team: ada' },
    ]);
  });

  it('returns empty when the AI is in no knowledge-bearing channels', async () => {
    hoisted.memberChannels = [];
    expect(
      await ChannelService.getKnowledgeForMemberChannels('ws_default', 'ai_1'),
    ).toEqual([]);
  });
});
