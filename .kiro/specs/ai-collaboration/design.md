# Design — AI-to-AI Collaboration (direction D)

> Architecture for Requirements 20–22. The center of gravity is §3
> (wake-chain loop prevention) — that is the real work; the tool and
> hand-off plumbing are comparatively mechanical.
>
> References: `.kiro/specs/ai-native-team-workspace/design.md`
> (runtime, agenticEmitter, Properties 11–13), Phase 1 channel
> membership, `.kiro/steering/conventions.md`.

## 0. Phasing (ship order = risk order)

| Phase | Requirement | Risk | Ships when |
|---|---|---|---|
| **D1** | Req 20 `check_teammate_tasks` | none (read-only) | immediately, standalone PR |
| **D2-a** | Req 22 wake-chain loop prevention | n/a (pure safety infra) | before any AI→AI wake |
| **D2-b** | Req 21 `assign_task` hand-off | bounded by D2-a | only after D2-a is merged + tested |

D1 is a clean win you can ship and demo on its own. D2-b is gated on
D2-a. Do NOT collapse these into one PR. Each PR branches from the
latest merged `main` (steering §12), since these phases touch disjoint
or additive code and need not be stacked.

## 1. Current wake mechanics (what we're extending)

Today there is exactly one producer of "wake an AI": `agenticEmitter`
emits `'wakeup'` with a bare `aiUserId`:

```ts
agenticEmitter.emit('wakeup', aiUserId);   // MessageService, ApprovalService
```

`AgenticLoop`'s listener calls `runForAI(aiUserId)`, which de-dupes via
the `inFlight` set, checks pending approvals, checks
`budget.shouldPauseCycle()` (audit M1), then `runCycle`.

Producers today:
- `MessageService.wakeMentionedAIs` — human @mention only (`if (!user.isAI)`).
- `ApprovalService.approve` — on `PENDING → APPROVED`.

Both are human-rooted, so loops are impossible today. D2 adds an
AI-rooted producer (`assign_task`), which is what creates loop risk and
why §3 must merge first.

## 2. Phase D1 — `check_teammate_tasks` (read-only)

Mechanical, mirrors the existing tool branches.

- `lib/ai/tools/index.ts`:
  - Add `check_teammate_tasks` to `TOOL_DEFINITIONS` (8 → 9). Update the
    Property 12 reference + the closed-set test.
  - Add Zod schema `{ aiUserId?: string; aiName?: string }` with a
    refine "at least one present".
  - Dispatcher branch: resolve the target AI (by id or name within the
    active workspace), call a new `TaskService.summarizeForAI(targetId)`
    returning counts by status + recent (24h) task titles; render to
    text. Wrap in the dispatcher's existing try/catch (Property 13).
- `lib/services/task.service.ts`: add `summarizeForAI(aiUserId)` —
  a workspace-scoped read (audit H4) grouping the AI's
  created/assigned tasks by status. Add the matching prisma mock in the
  test (steering §9).
- Role prompts: a short line that AIs may check a teammate's work
  (Property 11 preserved — edit the role constants).
- Tests: resolve-by-id, resolve-by-name, missing-selector → is_error,
  unknown target → is_error, toolSet whitelist still gates it, summary
  counts.

No wake, no chain — Requirement 22 is not needed for D1.

## 3. Phase D2-a — wake-chain loop prevention (the core)

### 3.1 The wake-chain context

Introduce a typed payload that travels with every wake instead of a
bare string:

```ts
// lib/loop/wake-chain.ts
export interface WakeContext {
  chainId: string;             // uuid; identifies one human-rooted chain
  hop: number;                 // 0 for human-initiated, +1 per AI hop
  originUserId: string;        // the human who started the chain
  fromAiUserId: string | null; // the AI that initiated THIS wake (null = human)
}
```

`fromAiUserId` rides on the context so the single chokepoint (§3.3) can
do per-pair accounting without the listener having to know the caller
out of band.

The `agenticEmitter` 'wakeup' payload becomes
`(aiUserId: string, ctx: WakeContext)`. All emit sites are updated:
- Human mention → `startHumanChain(humanUserId)` → one fresh context
  `{ chainId: uuid(), hop: 0, originUserId, fromAiUserId: null }`. A
  message that mentions several AIs uses the SAME context for all of
  them, so one human action is one chain (its fan-out counts against
  that chain's activation budget).
- Approval approve → `startHumanChain(deciderUserId)` (the deciding
  human is the origin).
- AI hand-off (D2-b) → `deriveChildContext(parentCtx, callerAiUserId)`
  → `{ chainId: parentCtx.chainId, hop: parentCtx.hop + 1,
  originUserId: parentCtx.originUserId, fromAiUserId: callerAiUserId }`.

### 3.2 The gatekeeper

A single pure function owns the decision "may this wake proceed?":

```ts
// lib/loop/wake-chain.ts
export type WakeDenyReason =
  | 'hop_budget'        // ctx.hop exceeds AI_WAKE_MAX_HOPS
  | 'pair_repeat'       // (fromAI→toAI) fired AI_WAKE_MAX_PAIR_REPEATS times in this chain
  | 'chain_activation'; // chain hit AI_WAKE_MAX_CHAIN_ACTIVATIONS total activations

export function authorizeWake(
  fromAiUserId: string | null,   // null = human-initiated
  toAiUserId: string,
  ctx: WakeContext,
  now?: number,                  // injected clock, only for idle eviction
): { ok: true } | { ok: false; reason: WakeDenyReason };
```

Decision order (Req 22.2 / 22.3 / 22.4):

1. **Hop depth**: if `ctx.hop > AI_WAKE_MAX_HOPS` →
   `{ ok: false, reason: 'hop_budget' }`.
2. Look up (or lazily create) the chain's `ChainState` by `ctx.chainId`.
3. **Chain activation**: if `state.activations >= AI_WAKE_MAX_CHAIN_ACTIVATIONS`
   → `{ ok: false, reason: 'chain_activation' }`.
4. **Per-pair repeat** (only when `fromAiUserId !== null`): if
   `state.pairCounts['fromAI→toAI'] >= AI_WAKE_MAX_PAIR_REPEATS` →
   `{ ok: false, reason: 'pair_repeat' }`.
5. Otherwise RECORD the wake (increment `state.activations`; increment
   the ordered-pair count when `fromAiUserId !== null`; bump
   `lastActivityAt`) and return `{ ok: true }`.

```ts
interface ChainState {
  activations: number;                 // total authorized wakes in this chain
  pairCounts: Map<string, number>;     // "fromAI→toAI" -> count, this chain only
  lastActivityAt: number;              // for idle eviction
}
```

State is a process-local `Map<chainId, ChainState>` with idle eviction
once a chain has been quiet longer than a TTL constant
(`CHAIN_IDLE_TTL_MS`, e.g. 10 min — an internal constant, not an env
var, to keep the env surface small). This mirrors `lib/ratelimit.ts`'s
in-memory + sweep design (steering §8). The counters themselves need no
clock — only the sweep does, which is why `now` is an injectable
parameter used solely for eviction. A `__resetForTests()` export clears
the map between cases. A Redis-backed implementation is a noted
follow-up for multi-pod (steering already lists the Redis migration
items).

Why these three budgets, not the old "hop 2 + 60 s cooldown":

- **Hop depth (6)** bounds how *deep* a relay can go before it must
  wrap up — enough for a real `human → A → B → C → …` relay.
- **Per-pair repeat (3, per chain)** replaces the wall-clock cooldown.
  The cooldown blocked *all* re-waking of a pair for 60 s, which also
  blocked a legitimate quick hand-back. A per-chain repeat counter
  instead lets `A → B → A` (and a couple of rounds) happen but kills an
  unbounded `A ⇄ B ⇄ A ⇄ B …`. It is deterministic (no timer), so the
  test does not need a fake clock.
- **Chain activations (12)** is the only budget that bounds *fan-out*:
  hop depth can't cap a wide tree (many siblings at the same hop), and
  per-pair can't either (different targets). Total activations caps the
  whole fan-out × depth tree.
- **Dollar budget (M1)** stays the independent absolute ceiling — see
  §3.5.

### 3.3 Where the gate sits

`AgenticLoop`'s wakeup listener becomes the single chokepoint:

```ts
agenticEmitter.on('wakeup', (toAiUserId, ctx) => {
  const verdict = authorizeWake(ctx.fromAiUserId, toAiUserId, ctx);
  if (!verdict.ok) {
    logger.warn(
      { event: `wake_suppressed_${verdict.reason}`, toAiUserId, ctx },
      'Wake suppressed by loop guard',
    );
    return;                            // suppressed — no cycle
  }
  void runForAI(toAiUserId, ctx);      // ctx threaded so the cycle can derive children
});
```

`runForAI(aiUserId, ctx)` threads `ctx` into `runCycle`, which makes it
available to `dispatchTool` so the `assign_task` branch (D2-b) can
derive the child context with `hop + 1` and the caller as
`fromAiUserId`. The existing `inFlight` / pending-approval /
`shouldPauseCycle` gates inside `runForAI` are unchanged and run AFTER
the wake is authorized.

> Note: `authorizeWake` records the activation at the chokepoint, i.e.
> when the wake is admitted (before `inFlight` de-dup). The `assign_task`
> tool also reports the verdict in its `tool_result`, so the model
> learns immediately whether its hand-off took effect — but the gate of
> record is the single function above, called once per wake.

### 3.4 Preserving the human-only mention guard (Req 22.7)

`MessageService.create` keeps its guard; only the payload it passes
grows a context:

```ts
// Human mention → start a fresh chain (hop 0). UNCHANGED guard.
if (!user.isAI) {
  void wakeMentionedAIs(content, userId, channelId);
  // wakeMentionedAIs builds one startHumanChain(userId) context and
  // emits ('wakeup', ai.id, ctx) for each matched, channel-member AI.
}
// AI messages still do NOT wake from message content — there is no
// else branch. AI→AI influence happens ONLY through the explicit
// assign_task tool (D2-b), which carries a WakeContext. "An AI
// mentioning another AI in prose" stays inert, exactly as today.
```

Key point: we are NOT making `@AI` in an AI's message wake anyone (the
dangerous line in the original proposal). The `if (!user.isAI)` guard
is preserved verbatim. AI→AI wake is ONLY via the explicit,
hop-counted `assign_task` tool.

### 3.5 Why this is safe

- Every chain roots at a human (hop 0, `fromAiUserId = null`). AIs can
  only ADD hops; they can never start a chain.
- Hop budget caps relay DEPTH (`AI_WAKE_MAX_HOPS`, default 6).
- Chain-activation budget caps total work across the fan-out × depth
  TREE (`AI_WAKE_MAX_CHAIN_ACTIVATIONS`, default 12) — the real
  fan-out guard.
- Per-pair repeat budget kills unbounded `A ⇄ B` ping-pong while still
  allowing a finite hand-back (`AI_WAKE_MAX_PAIR_REPEATS`, default 3,
  per chain).
- The dollar budget (M1) is the independent absolute backstop, checked
  per cycle in `runForAI` regardless of the wake-chain counters.
- The ONLY new wake producer is the explicit `assign_task` tool, so the
  set of ways an AI can wake another is small, explicit, and auditable.

## 4. Phase D2-b — `assign_task` hand-off (Req 21)

Only after §3 is merged + tested. Gated behind `AI_HANDOFF_ENABLED`
(default false).

- New tool `assign_task` (surface 9 → 10). A dedicated tool — NOT an
  extension of `update_task_status` — keeps the latter's contract
  unchanged and makes the wake-bearing action explicit and separately
  whitelist-able (audit C4).
  - Zod: `{ taskId: string, assigneeId?: string, assigneeName?: string }`
    (refine: at least one assignee selector).
- Dispatcher branch:
  1. Resolve the assignee (by id or name) within the workspace; it must
     be an AI sharing a channel with the caller (Req 21.4) — reject with
     `is_error` and no wake otherwise.
  2. `TaskService.assign(taskId, assigneeId)` (workspace-scoped write,
     broadcasts `task:updated` post-commit like the other task writes).
  3. Derive the child wake context from the cycle's `ctx`
     (`deriveChildContext(ctx, callerAiUserId)`), call
     `authorizeWake(callerAiUserId, assigneeId, childCtx)`.
  4. If `ok`, `agenticEmitter.emit('wakeup', assigneeId, childCtx)` and
     the `tool_result` says "assigned + woke <teammate>". If suppressed,
     the `tool_result` says "assigned; wake suppressed (<reason>)" so
     the model does not retry.
- **Fan-out / hand-back** fall out for free: a cycle may call
  `assign_task` several times (each is an independent
  `authorizeWake` + emit), and may target an AI earlier in the chain
  (bounded by the per-pair budget). No extra code beyond the per-call
  gate.
- Threading: `runCycle` carries the cycle's `WakeContext` into
  `dispatchTool` (via `ToolDispatchContext`) so the hand-off branch can
  build the child context. When a cycle has no context (e.g. the
  periodic auto-tick, which is not human-rooted), `assign_task` either
  starts no chain or is treated as hop-0-from-tick per a documented
  rule; the MVP keeps auto-tick hand-offs disabled to preserve the
  "every chain roots at a human" invariant.
- Role prompts (`lib/ai/prompts.ts`) extended to describe delegation,
  fan-out, hand-back, and the wrap-up-to-human expectation (Property 11
  preserved: still role-keyed, we edit the constants).

## 5. Testing

| Req | Test |
|---|---|
| 20 | tool resolves by id / name; missing selector → is_error; unknown target → is_error; whitelist gates it; summary counts correct. |
| 22.2 | a wake at `hop = AI_WAKE_MAX_HOPS + 1` → suppressed (`hop_budget`); a wake within depth proceeds. |
| 22.3 | the same ordered pair fired `AI_WAKE_MAX_PAIR_REPEATS` times succeeds; the next one in the same chain → suppressed (`pair_repeat`); a different target or a new chain is unaffected. |
| 22.4 | a wide fan-out is admitted until `AI_WAKE_MAX_CHAIN_ACTIVATIONS`, then suppressed (`chain_activation`). |
| 22.1 / 22.7 | human mention starts a hop-0 chain (`fromAiUserId = null`); AI prose mention wakes no one. |
| 22.5 | dollar-budget gate (`shouldPauseCycle`) still fires independently of all wake-chain counters. |
| 22.9 | chain state is evicted after the idle TTL (clock injected). |
| 21 | assign to non-shared AI → is_error + no wake; successful assign emits a hop+1 wake; suppressed hand-off reports the reason in `tool_result`; assignee acknowledgement (a plain message) re-wakes no one; `AI_HANDOFF_ENABLED=false` removes / disables the tool. |

`authorizeWake` and the chain helpers are pure/deterministic — the
counter budgets need no clock at all, and only the idle-eviction sweep
takes an injected `now`. So loop prevention is unit-tested without a
live loop — the same approach used for `lib/ratelimit.ts`.

## 6. Rollout / flags

- **D1**: no flag needed (read-only).
- **D2-a**: the wake-chain infra is always active once merged. It only
  adds safety; with no AI wake producer yet (assign_task ships in
  D2-b), it is inert in practice. Human mentions and approvals simply
  start hop-0 chains that never branch.
- **D2-b**: gate `assign_task` behind `AI_HANDOFF_ENABLED` (default
  false) so loop prevention can soak in production with the hand-off
  tool dormant before it is switched on.

### New env vars (land in `.env.example` / `.env.production.example` / `LAUNCH_CHECKLIST.md`)

| Var | Default | Meaning |
|---|---|---|
| `AI_WAKE_MAX_HOPS` | `6` | Max relay DEPTH per chain. |
| `AI_WAKE_MAX_PAIR_REPEATS` | `3` | Max times one ordered `(fromAI→toAI)` edge may fire per chain. |
| `AI_WAKE_MAX_CHAIN_ACTIVATIONS` | `12` | Max TOTAL authorized wakes (fan-out × depth) per chain. |
| `AI_HANDOFF_ENABLED` | `false` | Master switch for the `assign_task` hand-off tool (D2-b). |

> The originally-proposed `AI_WAKE_PAIR_COOLDOWN_MS` is intentionally
> NOT added — the per-chain pair-repeat counter (22.3) supersedes it.
