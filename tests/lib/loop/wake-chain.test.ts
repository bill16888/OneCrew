import '../../setup';

/**
 * @file Unit tests for wake-chain loop prevention (direction D, Req 22).
 *
 * authorizeWake is a pure function over a process-local chain map; the
 * counter budgets need no clock, so loop prevention is verified WITHOUT
 * running a live loop. A `now` is injected only for the idle-eviction
 * test. Tests run against the env defaults: AI_WAKE_MAX_HOPS=6,
 * AI_WAKE_MAX_PAIR_REPEATS=3, AI_WAKE_MAX_CHAIN_ACTIVATIONS=12.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  authorizeWake,
  deriveChildContext,
  startHumanChain,
  __resetWakeChainsForTests,
  __wakeChainSizeForTests,
  type WakeContext,
} from '@/lib/loop/wake-chain';

const HUMAN = 'user_human';
const ADA = 'user_ai_ada';
const HOPPER = 'user_ai_hopper';
const KAY = 'user_ai_kay';

beforeEach(() => {
  __resetWakeChainsForTests();
});

describe('startHumanChain / deriveChildContext (Req 22.1)', () => {
  it('roots a chain at a human: hop 0, no fromAi, fresh chainId', () => {
    const a = startHumanChain(HUMAN);
    const b = startHumanChain(HUMAN);
    expect(a.hop).toBe(0);
    expect(a.fromAiUserId).toBeNull();
    expect(a.originUserId).toBe(HUMAN);
    expect(a.chainId).toMatch(/[0-9a-f-]{36}/);
    // Each human action is its own chain.
    expect(a.chainId).not.toBe(b.chainId);
  });

  it('derives a child: same chain, hop+1, origin preserved, fromAi set', () => {
    const root = startHumanChain(HUMAN);
    const child = deriveChildContext(root, ADA);
    expect(child.chainId).toBe(root.chainId);
    expect(child.hop).toBe(root.hop + 1);
    expect(child.originUserId).toBe(HUMAN);
    expect(child.fromAiUserId).toBe(ADA);

    const grandchild = deriveChildContext(child, HOPPER);
    expect(grandchild.chainId).toBe(root.chainId);
    expect(grandchild.hop).toBe(2);
    expect(grandchild.fromAiUserId).toBe(HOPPER);
  });
});

describe('authorizeWake — hop depth budget (Req 22.2)', () => {
  it('admits a wake at exactly AI_WAKE_MAX_HOPS', () => {
    const ctx: WakeContext = {
      chainId: 'c_hop',
      hop: 6,
      originUserId: HUMAN,
      fromAiUserId: ADA,
    };
    expect(authorizeWake(ADA, HOPPER, ctx)).toEqual({ ok: true });
  });

  it('suppresses a wake one hop past the budget', () => {
    const ctx: WakeContext = {
      chainId: 'c_hop2',
      hop: 7,
      originUserId: HUMAN,
      fromAiUserId: ADA,
    };
    expect(authorizeWake(ADA, HOPPER, ctx)).toEqual({
      ok: false,
      reason: 'hop_budget',
    });
  });
});

describe('authorizeWake — per-pair repeat budget (Req 22.3)', () => {
  it('allows the same ordered pair up to N times, then suppresses', () => {
    const ctx: WakeContext = {
      chainId: 'c_pair',
      hop: 1,
      originUserId: HUMAN,
      fromAiUserId: ADA,
    };
    // AI_WAKE_MAX_PAIR_REPEATS = 3: first three Ada->Hopper succeed.
    for (let i = 0; i < 3; i++) {
      expect(authorizeWake(ADA, HOPPER, ctx)).toEqual({ ok: true });
    }
    // The 4th repeat of the SAME ordered edge in this chain is blocked.
    expect(authorizeWake(ADA, HOPPER, ctx)).toEqual({
      ok: false,
      reason: 'pair_repeat',
    });
  });

  it('does not count the reverse edge against the forward edge', () => {
    const ctx: WakeContext = {
      chainId: 'c_handback',
      hop: 1,
      originUserId: HUMAN,
      fromAiUserId: ADA,
    };
    // A finite hand-back A->B->A works: the directed edges are distinct.
    expect(authorizeWake(ADA, HOPPER, ctx)).toEqual({ ok: true });
    expect(authorizeWake(HOPPER, ADA, ctx)).toEqual({ ok: true });
    expect(authorizeWake(ADA, HOPPER, ctx)).toEqual({ ok: true });
    expect(authorizeWake(HOPPER, ADA, ctx)).toEqual({ ok: true });
  });

  it('resets the per-pair counter for a fresh chain', () => {
    const c1: WakeContext = {
      chainId: 'c_a',
      hop: 1,
      originUserId: HUMAN,
      fromAiUserId: ADA,
    };
    for (let i = 0; i < 3; i++) authorizeWake(ADA, HOPPER, c1);
    expect(authorizeWake(ADA, HOPPER, c1).ok).toBe(false);

    // A different chain id starts the pair counter over.
    const c2: WakeContext = { ...c1, chainId: 'c_b' };
    expect(authorizeWake(ADA, HOPPER, c2)).toEqual({ ok: true });
  });

  it('never applies the per-pair budget to human-rooted wakes', () => {
    const ctx = startHumanChain(HUMAN);
    // A human fanning out to the same AI repeatedly (fromAi null) is
    // bounded only by the chain-activation budget, not per-pair.
    for (let i = 0; i < 5; i++) {
      expect(authorizeWake(null, ADA, ctx)).toEqual({ ok: true });
    }
  });
});

describe('authorizeWake — chain activation budget (Req 22.4)', () => {
  it('admits up to AI_WAKE_MAX_CHAIN_ACTIVATIONS, then suppresses', () => {
    const ctx = startHumanChain(HUMAN);
    // Human-rooted fan-out (fromAi null) avoids the per-pair budget, so
    // this isolates the total-activation guard. Default cap = 12.
    for (let i = 0; i < 12; i++) {
      expect(authorizeWake(null, ADA, ctx)).toEqual({ ok: true });
    }
    expect(authorizeWake(null, ADA, ctx)).toEqual({
      ok: false,
      reason: 'chain_activation',
    });
  });

  it('counts the whole fan-out × depth tree against one chain', () => {
    const root = startHumanChain(HUMAN);
    // Mix distinct targets and a hand-off hop; every authorized wake
    // increments the same chain's activation counter.
    let admitted = 0;
    const targets = [ADA, HOPPER, KAY];
    // 12 activations total across varied edges, all in `root`'s chain.
    outer: for (let round = 0; round < 10; round++) {
      for (const to of targets) {
        const from = round % 2 === 0 ? null : ADA;
        const v = authorizeWake(from, to, {
          ...root,
          hop: from === null ? 0 : 1,
          fromAiUserId: from,
        });
        if (v.ok) admitted++;
        else {
          expect(v.reason).toBe('chain_activation');
          break outer;
        }
      }
    }
    expect(admitted).toBe(12);
  });
});

describe('authorizeWake — idle eviction (Req 22.9)', () => {
  it('evicts a chain that has been idle past the TTL', () => {
    const t0 = 1_000_000;
    const ctx = startHumanChain(HUMAN);
    expect(authorizeWake(null, ADA, ctx, t0)).toEqual({ ok: true });
    expect(__wakeChainSizeForTests()).toBe(1);

    // A wake for a DIFFERENT chain ~11 min later sweeps the idle one.
    const later = t0 + 11 * 60_000;
    const other = startHumanChain(HUMAN);
    expect(authorizeWake(null, HOPPER, other, later)).toEqual({ ok: true });
    // Only the fresh chain remains.
    expect(__wakeChainSizeForTests()).toBe(1);
  });

  it('keeps a chain that is still within the TTL', () => {
    const t0 = 2_000_000;
    const a = startHumanChain(HUMAN);
    const b = startHumanChain(HUMAN);
    authorizeWake(null, ADA, a, t0);
    authorizeWake(null, HOPPER, b, t0 + 60_000);
    expect(__wakeChainSizeForTests()).toBe(2);
  });
});

describe('authorizeWake — determinism / independence', () => {
  it('decides purely from injected counters and clock (no hidden state)', () => {
    // Same inputs from a clean map always yield the same verdict — the
    // function reads no wall clock for the counter budgets and never
    // consults the dollar budget (audit M1 stays an independent gate
    // enforced separately in the Agentic Loop).
    const ctx: WakeContext = {
      chainId: 'c_det',
      hop: 3,
      originUserId: HUMAN,
      fromAiUserId: ADA,
    };
    __resetWakeChainsForTests();
    const first = authorizeWake(ADA, HOPPER, ctx, 0);
    __resetWakeChainsForTests();
    const second = authorizeWake(ADA, HOPPER, ctx, 0);
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true });
  });
});
