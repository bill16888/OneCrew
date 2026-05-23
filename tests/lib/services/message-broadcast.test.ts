import '../../setup';

/**
 * @file Property tests for the `message:new` broadcast contract.
 *
 * Properties covered:
 *   - Property 3 (消息持久化—广播一致性): exactly one event emitted
 *     per persisted message; nothing emitted on persistence failure.
 *   - Property 4 (AI 来源标记): `fromAI === sender.isAI`.
 *
 * Validates: Requirements 2.3, 2.4, 2.5, 4.4, 8.4, 10.4
 *           (P2 tasks 3.11, 3.12).
 *
 * Implementation note: `vi.mock` factories are hoisted to the top of
 * the file, BEFORE module-level `let`/`const` declarations. Closing
 * over file-scope state from inside the factory throws
 * `ReferenceError: Cannot access X before initialization`. We use
 * `vi.hoisted(() => ...)` to lift the shared mock state alongside the
 * factory, mirroring the pattern documented in vitest's mocking guide.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

interface CapturedEmit {
  room: string;
  event: string;
  payload: { channelId: string; fromAI: boolean; content: string };
}

const hoisted = vi.hoisted(() => {
  return {
    captured: [] as CapturedEmit[],
    lastRoom: { value: '' },
    nextSenderIsAI: { value: false },
    prismaCreateError: { value: null as Error | null },
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    message: {
      create: vi.fn(
        async (args: {
          data: { channelId: string; userId: string; content: string };
        }) => {
          if (hoisted.prismaCreateError.value) {
            const e = hoisted.prismaCreateError.value;
            hoisted.prismaCreateError.value = null;
            throw e;
          }
          return {
            id: `msg_${Math.random().toString(36).slice(2)}`,
            channelId: args.data.channelId,
            userId: args.data.userId,
            content: args.data.content,
            metadata: null,
            createdAt: new Date(),
            user: { isAI: hoisted.nextSenderIsAI.value },
          };
        },
      ),
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({
  getIO: () => ({
    to: (room: string) => {
      hoisted.lastRoom.value = room;
      return {
        emit: (event: string, payload: CapturedEmit['payload']) => {
          hoisted.captured.push({ room: hoisted.lastRoom.value, event, payload });
        },
      };
    },
  }),
}));

import { MessageService } from '@/lib/services/message.service';

beforeEach(() => {
  hoisted.captured.splice(0);
  hoisted.nextSenderIsAI.value = false;
  hoisted.prismaCreateError.value = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 3: 消息持久化—广播一致性', () => {
  it('emits exactly one message:new event per successful persistence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 200 })
          .filter((s) => s.trim().length > 0),
        async (content) => {
          hoisted.captured.splice(0);
          hoisted.nextSenderIsAI.value = false;
          await MessageService.create({
            channelId: 'chan_general',
            userId: 'u_test',
            content,
          });
          expect(hoisted.captured).toHaveLength(1);
          expect(hoisted.captured[0].event).toBe('message:new');
          expect(hoisted.captured[0].room).toBe('channel:chan_general');
          expect(hoisted.captured[0].payload.content).toBe(content);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('does NOT emit when persistence fails', async () => {
    hoisted.captured.splice(0);
    hoisted.prismaCreateError.value = new Error('db down');
    await expect(
      MessageService.create({
        channelId: 'chan_general',
        userId: 'u_test',
        content: 'will fail',
      }),
    ).rejects.toThrow('db down');
    expect(hoisted.captured).toHaveLength(0);
  });
});

describe('Feature: ai-native-team-workspace, Property 4: AI 来源标记', () => {
  it('fromAI mirrors sender.isAI', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (isAI) => {
        hoisted.captured.splice(0);
        hoisted.nextSenderIsAI.value = isAI;
        await MessageService.create({
          channelId: 'chan_general',
          userId: isAI ? 'user_ai_ada' : 'u_human',
          content: 'hello',
        });
        expect(hoisted.captured).toHaveLength(1);
        expect(hoisted.captured[0].payload.fromAI).toBe(isAI);
      }),
      { numRuns: 30 },
    );
  });
});
