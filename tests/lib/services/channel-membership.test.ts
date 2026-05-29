import '../../setup';

/**
 * @file Tests for channel membership (Phase 1 Req 17).
 *
 * Covers the ChannelService member helpers and — crucially — the
 * MessageService.create membership enforcement, which is a behavioural
 * change that must reject non-members while letting members through.
 * Prisma is mocked so the contract is pinned without a database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  isMember: { value: true },
  upsertedRole: { value: '' },
  deletedCount: { value: 1 },
  userIsAI: { value: false },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    channel: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => ({
        id: args.where.id,
      })),
    },
    channelMember: {
      findUnique: vi.fn(async () =>
        hoisted.isMember.value ? { channelId: 'c1' } : null,
      ),
      findMany: vi.fn(async () => [
        {
          userId: 'u_human',
          role: 'human',
          joinedAt: new Date('2026-05-29T00:00:00Z'),
          user: { name: 'Mia', isAI: false },
        },
      ]),
      upsert: vi.fn(async (args: { create: { role: string } }) => {
        hoisted.upsertedRole.value = args.create.role;
        return {};
      }),
      deleteMany: vi.fn(async () => ({ count: hoisted.deletedCount.value })),
    },
    user: {
      findUnique: vi.fn(async () => ({ isAI: hoisted.userIsAI.value })),
    },
    message: {
      create: vi.fn(async (args: { data: { channelId: string; userId: string; content: string } }) => ({
        id: 'msg_1',
        channelId: args.data.channelId,
        userId: args.data.userId,
        content: args.data.content,
        metadata: null,
        createdAt: new Date(),
        user: { isAI: false },
      })),
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({ getIO: () => null }));

import { ChannelService } from '@/lib/services/channel.service';
import { MessageService, ValidationError } from '@/lib/services/message.service';

beforeEach(() => {
  hoisted.isMember.value = true;
  hoisted.upsertedRole.value = '';
  hoisted.deletedCount.value = 1;
  hoisted.userIsAI.value = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MessageService.create — membership enforcement (Req 17.2)', () => {
  it('allows a member to post', async () => {
    hoisted.isMember.value = true;
    const msg = await MessageService.create({
      channelId: 'c1',
      userId: 'u_member',
      content: 'hi',
    });
    expect(msg.id).toBe('msg_1');
  });

  it('rejects a non-member with ValidationError', async () => {
    hoisted.isMember.value = false;
    await expect(
      MessageService.create({
        channelId: 'c1',
        userId: 'u_outsider',
        content: 'hi',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ChannelService member helpers', () => {
  it('isMember reflects the membership row presence', async () => {
    hoisted.isMember.value = true;
    expect(await ChannelService.isMember('c1', 'u1')).toBe(true);
    hoisted.isMember.value = false;
    expect(await ChannelService.isMember('c1', 'u1')).toBe(false);
  });

  it('listMembers projects user name + isAI', async () => {
    const members = await ChannelService.listMembers('c1');
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      userId: 'u_human',
      name: 'Mia',
      isAI: false,
      role: 'human',
    });
  });

  it('addMember derives role=ai for AI users', async () => {
    hoisted.userIsAI.value = true;
    await ChannelService.addMember('c1', 'u_ai');
    expect(hoisted.upsertedRole.value).toBe('ai');
  });

  it('addMember derives role=human for human users', async () => {
    hoisted.userIsAI.value = false;
    await ChannelService.addMember('c1', 'u_human');
    expect(hoisted.upsertedRole.value).toBe('human');
  });

  it('removeMember returns true when a row was deleted, false otherwise', async () => {
    hoisted.deletedCount.value = 1;
    expect(await ChannelService.removeMember('c1', 'u1')).toBe(true);
    hoisted.deletedCount.value = 0;
    expect(await ChannelService.removeMember('c1', 'u1')).toBe(false);
  });
});
