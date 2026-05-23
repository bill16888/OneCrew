import '../../setup';

/**
 * @file Property test for `MessageService.create` content validation.
 *
 * Property 5 (消息内容校验): for any string `content`, the service
 * accepts it iff `content.trim().length > 0` AND
 * `content.length <= 8000`; otherwise it rejects with a
 * `ValidationError` and persists nothing.
 *
 * Validates: Requirements 2.6, 2.7 (P2 task 3.13).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

const hoisted = vi.hoisted(() => ({
  prismaCreate: vi.fn(
    async (args: { data: { content: string } }) => ({
      id: 'msg_test',
      channelId: 'c_test',
      userId: 'u_test',
      content: args.data.content,
      metadata: null,
      createdAt: new Date(),
      user: { isAI: false },
    }),
  ),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    message: {
      create: hoisted.prismaCreate,
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({
  getIO: () => null,
}));

import {
  MESSAGE_MAX_LENGTH,
  MessageService,
  ValidationError,
} from '@/lib/services/message.service';

beforeEach(() => {
  hoisted.prismaCreate.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 5: 消息内容校验', () => {
  it('rejects blank-only content without persisting', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 32 }).filter((s) => s.trim().length === 0),
        async (blank) => {
          await expect(
            MessageService.create({
              channelId: 'c1',
              userId: 'u1',
              content: blank,
            }),
          ).rejects.toBeInstanceOf(ValidationError);
        },
      ),
      { numRuns: 50 },
    );
    expect(hoisted.prismaCreate).not.toHaveBeenCalled();
  });

  it('rejects content longer than the 8000-char cap', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: MESSAGE_MAX_LENGTH + 1,
          max: MESSAGE_MAX_LENGTH + 200,
        }),
        async (len) => {
          const content = 'a'.repeat(len);
          await expect(
            MessageService.create({
              channelId: 'c1',
              userId: 'u1',
              content,
            }),
          ).rejects.toBeInstanceOf(ValidationError);
        },
      ),
      { numRuns: 30 },
    );
    expect(hoisted.prismaCreate).not.toHaveBeenCalled();
  });

  it('accepts non-blank content within the cap', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: MESSAGE_MAX_LENGTH })
          .filter((s) => s.trim().length > 0),
        async (content) => {
          hoisted.prismaCreate.mockClear();
          await MessageService.create({
            channelId: 'c1',
            userId: 'u1',
            content,
          });
          expect(hoisted.prismaCreate).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 50 },
    );
  });
});
