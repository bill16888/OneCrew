/**
 * @file Wake-chain loop prevention (direction D, Requirement 22).
 *
 * Turning the AI colleagues into a team that can hand work to each
 * other (Req 21, phase D2-b) introduces a new way for one AI cycle to
 * start another — an AI-rooted wake. Left unbounded, that is exactly
 * the budget-burning `A → B → A → B …` spiral the deliberate
 * `if (!user.isAI)` guard in `MessageService.create` exists to prevent.
 *
 * This module is the SINGLE chokepoint that keeps AI-to-AI waking
 * safe. Every wake carries a {@link WakeContext} that traces back to
 * the HUMAN action that started it; {@link authorizeWake} is the one
 * pure function that decides whether a given wake may proceed, bounding
 * the causal tree on three independent axes:
 *
 *   1. **Hop depth** (`AI_WAKE_MAX_HOPS`, default 6) — how DEEP a relay
 *      may go (`human → A → B → C → …`).
 *   2. **Per-pair repeat** (`AI_WAKE_MAX_PAIR_REPEATS`, default 3) — how
 *      many times the same ordered `(fromAI → toAI)` edge may fire
 *      within ONE chain. Replaces the original wall-clock cooldown: it
 *      permits a finite hand-back (`A → B → A`) but kills an unbounded
 *      `A ⇄ B` ping-pong. Deterministic — no clock needed.
 *   3. **Chain activations** (`AI_WAKE_MAX_CHAIN_ACTIVATIONS`, default
 *      12) — the TOTAL number of authorized wakes across the whole
 *      fan-out × depth tree. This is the only budget that bounds
 *      fan-out (many siblings at the same hop).
 *
 * The daily USD budget (`Budget.shouldPauseCycle`, audit M1) remains a
 * separate, absolute backstop checked per cycle in the Agentic Loop —
 * it is orthogonal to these counters and neither replaces the other.
 *
 * Design notes:
 *   - Pure + deterministic: the counter budgets need no clock, so loop
 *     prevention is unit-tested WITHOUT running a live loop. A `now`
 *     parameter is injected ONLY for idle eviction of chain state,
 *     mirroring `lib/ratelimit.ts`.
 *   - Process-local state: a bounded in-memory `Map<chainId,
 *     ChainState>` with idle eviction. A multi-pod deployment would
 *     multiply the budgets by the pod count; a Redis-backed
 *     implementation is the noted follow-up (same trade-off as the
 *     rate limiter).
 *
 * Validates: Requirement 22 (.kiro/specs/ai-collaboration).
 */

import { randomUUID } from 'node:crypto';

import { env } from '@/lib/env';

/**
 * The causal context carried by every wake.
 *
 * A human action (channel @mention, approval decision) starts a fresh
 * chain via {@link startHumanChain}: `hop = 0`, `fromAiUserId = null`,
 * `originUserId` = the human. An AI hand-off (Req 21, D2-b) derives a
 * child via {@link deriveChildContext}: same `chainId`, `hop + 1`, same
 * `originUserId`, and `fromAiUserId` = the assigning AI so the
 * chokepoint can do per-ordered-pair accounting without out-of-band
 * caller info.
 */
export interface WakeContext {
  /** Identifies one human-rooted chain. */
  readonly chainId: string;
  /** 0 for a human-initiated wake; +1 per AI hand-off. */
  readonly hop: number;
  /** `User.id` of the human who started the chain. */
  readonly originUserId: string;
  /** The AI that initiated THIS wake; `null` for a human-initiated wake. */
  readonly fromAiUserId: string | null;
}

/**
 * Why {@link authorizeWake} suppressed a wake. Surfaced in the
 * suppression log and (for AI hand-offs, D2-b) in the triggering tool's
 * `tool_result` so the model learns not to retry.
 */
export type WakeDenyReason = 'hop_budget' | 'pair_repeat' | 'chain_activation';

/** Verdict returned by {@link authorizeWake}. */
export type WakeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WakeDenyReason };

/**
 * Per-chain accounting. `pairCounts` is keyed by the ordered edge
 * `"<fromAiUserId>-><toAiUserId>"` so the per-pair budget is scoped to
 * a single chain (a fresh human action resets it).
 */
interface ChainState {
  activations: number;
  pairCounts: Map<string, number>;
  lastActivityAt: number;
}

/**
 * Idle TTL after which a quiet chain's state is evicted. Kept as an
 * internal constant (not an env var) to keep the operator-facing env
 * surface small; 10 minutes comfortably outlives any realistic relay
 * while bounding memory. Mirrors the eviction discipline in
 * `lib/ratelimit.ts`.
 */
const CHAIN_IDLE_TTL_MS = 10 * 60_000;

/** Process-local chain accounting. See the file header for the rationale. */
const chains = new Map<string, ChainState>();

/**
 * Build the ordered-pair key for the per-pair budget. Cuids contain no
 * `-`-then-`>` sequence, so `->` is a collision-free separator.
 */
function pairKeyOf(fromAiUserId: string, toAiUserId: string): string {
  return `${fromAiUserId}->${toAiUserId}`;
}

/**
 * Evict chains that have been idle longer than {@link CHAIN_IDLE_TTL_MS}.
 * Called at the top of every {@link authorizeWake} so the map can never
 * grow without bound. The map is small (one entry per concurrent
 * human-rooted chain) so the per-call sweep is cheap.
 */
function sweepIdle(now: number): void {
  const cutoff = now - CHAIN_IDLE_TTL_MS;
  for (const [chainId, state] of chains) {
    if (state.lastActivityAt < cutoff) {
      chains.delete(chainId);
    }
  }
}

/**
 * Start a fresh wake chain rooted at a HUMAN action.
 *
 * Used by `MessageService.wakeMentionedAIs` (one context reused for
 * every AI a single message mentions, so one human action is one
 * chain) and `ApprovalService.approve` (the deciding human is the
 * origin).
 *
 * @param originUserId `User.id` of the human who started the chain.
 */
export function startHumanChain(originUserId: string): WakeContext {
  return {
    chainId: randomUUID(),
    hop: 0,
    originUserId,
    fromAiUserId: null,
  };
}

/**
 * Derive the child context for an AI-initiated hand-off (Req 21, D2-b).
 * Same chain, one hop deeper, with the assigning AI recorded as the
 * `fromAiUserId` so {@link authorizeWake} can apply the per-pair budget.
 *
 * @param parent The cycle's current context.
 * @param fromAiUserId `User.id` of the AI issuing the hand-off.
 */
export function deriveChildContext(
  parent: WakeContext,
  fromAiUserId: string,
): WakeContext {
  return {
    chainId: parent.chainId,
    hop: parent.hop + 1,
    originUserId: parent.originUserId,
    fromAiUserId,
  };
}

/**
 * Decide whether a wake may proceed — the single chokepoint for loop
 * prevention (Requirement 22).
 *
 * Decision order (first failure wins):
 *   1. **Hop depth**: `ctx.hop > AI_WAKE_MAX_HOPS` → `hop_budget`.
 *   2. **Chain activations**: the chain already hit
 *      `AI_WAKE_MAX_CHAIN_ACTIVATIONS` → `chain_activation`.
 *   3. **Per-pair repeat** (AI-initiated only): the ordered
 *      `(fromAiUserId → toAiUserId)` edge already fired
 *      `AI_WAKE_MAX_PAIR_REPEATS` times in this chain → `pair_repeat`.
 *
 * On success the wake is RECORDED (activation + ordered-pair counter
 * incremented, `lastActivityAt` bumped) and `{ ok: true }` is returned.
 * The activation is recorded at admission time (before any downstream
 * de-dup), so a wake that is later skipped by the loop's in-flight
 * guard still counts toward the chain budget — the budget bounds the
 * causal tree, not the number of cycles that happen to run.
 *
 * Pure aside from the chain-state map: the counter budgets do not read
 * the clock. `now` is injected solely so idle eviction is deterministic
 * under test.
 *
 * @param fromAiUserId The AI issuing the wake, or `null` for a
 *   human-initiated wake (which skips the per-pair budget).
 * @param toAiUserId The AI being woken.
 * @param ctx The wake's {@link WakeContext}.
 * @param now Clock injection point for idle eviction; defaults to
 *   `Date.now()`.
 */
export function authorizeWake(
  fromAiUserId: string | null,
  toAiUserId: string,
  ctx: WakeContext,
  now: number = Date.now(),
): WakeVerdict {
  // Keep the chain map bounded; never blocks a request for more than
  // the (tiny) map size.
  sweepIdle(now);

  // 1. Hop depth — checked before touching state so an over-deep wake
  //    never even allocates a chain entry.
  if (ctx.hop > env.AI_WAKE_MAX_HOPS) {
    return { ok: false, reason: 'hop_budget' };
  }

  let state = chains.get(ctx.chainId);
  if (!state) {
    state = { activations: 0, pairCounts: new Map(), lastActivityAt: now };
    chains.set(ctx.chainId, state);
  }

  // 2. Chain activation budget — the real fan-out × depth guard.
  if (state.activations >= env.AI_WAKE_MAX_CHAIN_ACTIVATIONS) {
    return { ok: false, reason: 'chain_activation' };
  }

  // 3. Per-ordered-pair repeat budget — only for AI-initiated wakes; a
  //    human root has no `fromAiUserId` and so cannot ping-pong.
  let pairKey: string | null = null;
  if (fromAiUserId !== null) {
    pairKey = pairKeyOf(fromAiUserId, toAiUserId);
    if ((state.pairCounts.get(pairKey) ?? 0) >= env.AI_WAKE_MAX_PAIR_REPEATS) {
      return { ok: false, reason: 'pair_repeat' };
    }
  }

  // Record the authorized wake.
  state.activations += 1;
  if (pairKey !== null) {
    state.pairCounts.set(pairKey, (state.pairCounts.get(pairKey) ?? 0) + 1);
  }
  state.lastActivityAt = now;
  return { ok: true };
}

/**
 * Test-only: current number of tracked chains. Lets the idle-eviction
 * test observe that a quiet chain was actually dropped. Do not call
 * from app code.
 */
export function __wakeChainSizeForTests(): number {
  return chains.size;
}

/** Test-only: wipe all chain state between cases. Do not call from app code. */
export function __resetWakeChainsForTests(): void {
  chains.clear();
}
