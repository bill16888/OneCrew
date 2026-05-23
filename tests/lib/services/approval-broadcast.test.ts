import '../../setup';

/**
 * @file Property tests for the Approval flow events.
 *
 * Properties covered:
 *   - Property 16 (审批创建—广播一致性): exactly one
 *     `approval:created` per successful create; nothing on persistence
 *     failure.
 *   - Property 18 (审批状态值域): the service only writes rows with
 *     `status ∈ {PENDING, APPROVED, REJECTED}`.
 *   - Property 20 partial: `approve` fires `wakeup`, `reject` fires
 *     `reject`, neither overlaps.
 *
 * Validates: Requirements 5.8, 6.1, 6.2, 6.4, 8.6, 10.4
 *           (P2 tasks 9.6, 9.7, 9.8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedEmit {
  room: string;
  event: string;
}
interface CapturedEmitterEvent {
  channel: 'wakeup' | 'reject';
  aiUserId: string;
}

const hoisted = vi.hoisted(() => ({
  emitted: [] as CapturedEmit[],
  lastRoom: { value: '' },
  emitterEvents: [] as CapturedEmitterEvent[],
  approvalCreate: vi.fn(
    async ({ data }: { data: { status: string } }) => ({
      id: `app_${Math.random().toString(36).slice(2)}`,
      workspaceId: 'ws_test',
      aiUserId: 'user_ai_ada',
      action: 'send_channel_message',
      payload: { reason: 'r' },
      status: data.status,
      createdAt: new Date(),
      decidedById: null,
      decidedAt: null,
    }),
  ),
  approvalUpdate: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { status: 'APPROVED' | 'REJECTED'; decidedById: string };
    }) => ({
      id: where.id,
      workspaceId: 'ws_test',
      aiUserId: 'user_ai_ada',
      action: 'send_channel_message',
      payload: { reason: 'x' },
      status: data.status,
      decidedById: data.decidedById,
      decidedAt: new Date(),
      createdAt: new Date(),
    }),
  ),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    approval: {
      create: hoisted.approvalCreate,
      update: hoisted.approvalUpdate,
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@/lib/realtime/io', () => ({
  getIO: () => ({
    to: (room: string) => {
      hoisted.lastRoom.value = room;
      return {
        emit: (event: string) => {
          hoisted.emitted.push({ room: hoisted.lastRoom.value, event });
        },
      };
    },
  }),
}));

vi.mock('@/lib/loop/emitter', () => ({
  agenticEmitter: {
    emit: (channel: 'wakeup' | 'reject', aiUserId: string) => {
      hoisted.emitterEvents.push({ channel, aiUserId });
      return true;
    },
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn(),
  },
}));

import { ApprovalService } from '@/lib/services/approval.service';

beforeEach(() => {
  hoisted.emitted.splice(0);
  hoisted.emitterEvents.splice(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: ai-native-team-workspace, Property 16: 审批创建—广播一致性', () => {
  it('emits exactly one approval:created per successful create', async () => {
    await ApprovalService.create({
      aiUserId: 'user_ai_ada',
      action: 'send_channel_message',
      payload: { reason: 'r' },
    });
    expect(hoisted.emitted).toHaveLength(1);
    expect(hoisted.emitted[0].event).toBe('approval:created');
    expect(hoisted.emitted[0].room).toMatch(/^workspace:/);
  });

  it('does not emit when persistence fails', async () => {
    hoisted.approvalCreate.mockRejectedValueOnce(new Error('db down'));
    await expect(
      ApprovalService.create({
        aiUserId: 'user_ai_ada',
        action: 'create_task',
        payload: { reason: 'r' },
      }),
    ).rejects.toThrow('db down');
    expect(hoisted.emitted).toHaveLength(0);
  });
});

describe('Feature: ai-native-team-workspace, Property 18: 审批状态值域', () => {
  it('create writes status === PENDING', async () => {
    hoisted.approvalCreate.mockClear();
    await ApprovalService.create({
      aiUserId: 'user_ai_ada',
      action: 'send_channel_message',
      payload: {},
    });
    const arg = hoisted.approvalCreate.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(arg.data.status).toBe('PENDING');
  });

  it('approve writes status === APPROVED', async () => {
    hoisted.approvalUpdate.mockClear();
    await ApprovalService.approve('app_x', 'human_x');
    const arg = hoisted.approvalUpdate.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(arg.data.status).toBe('APPROVED');
  });

  it('reject writes status === REJECTED', async () => {
    hoisted.approvalUpdate.mockClear();
    await ApprovalService.reject('app_x', 'human_x');
    const arg = hoisted.approvalUpdate.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(arg.data.status).toBe('REJECTED');
  });
});

describe('Feature: ai-native-team-workspace, Property 20 partial: 拒绝不发 wakeup', () => {
  it('reject only fires the reject channel; approve only fires wakeup', async () => {
    hoisted.emitterEvents.splice(0);
    await ApprovalService.approve('app_x', 'human_x');
    expect(hoisted.emitterEvents).toEqual([
      { channel: 'wakeup', aiUserId: 'user_ai_ada' },
    ]);

    hoisted.emitterEvents.splice(0);
    await ApprovalService.reject('app_x', 'human_x');
    expect(hoisted.emitterEvents).toEqual([
      { channel: 'reject', aiUserId: 'user_ai_ada' },
    ]);
  });
});
