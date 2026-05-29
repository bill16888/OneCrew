# Design — AI-to-AI Collaboration (direction D)

> Architecture for Requirements 20–22. The center of gravity is §3
> (wake-chain loop prevention) — that is the real work; the tool and
> handoff plumbing are comparatively mechanical.
>
> References: `.kiro/specs/ai-native-team-workspace/design.md`
> (runtime, agenticEmitter, Properties 11–13), Phase 1 channel
> membership, `.kiro/steering/conventions.md`.

## 0. Phasing (ship order = risk order)

| Phase | Requirement | Risk | Ships when |
|---|---|---|---|
| **D1** | Req 20 `check_teammate_tasks` | none (read-only) | immediately, standalone PR |
| **D2-a** | Req 22 wake-chain loop prevention | n/a (pure safety infra) | before any AI→AI wake |
| **D2-b** | Req 21 task handoff | bounded by D2-a | only after D2-a is merged + tested |

D1 is a clean win you can ship and demo on its own. D2-b is gated on
D2-a. Do NOT collapse these into one PR.

## 1. Current wake mechanics (what we're extending)

Today there is exactly one producer of "wake an AI": `agenticEmitter`
emits `'wakeup'` with a bare `aiUserId`:

```ts
agenticEmitter.emit('wakeup', aiUserId);   // MessageService, ApprovalService
```

`AgenticLoop` listens and calls `runForAI(aiUserId)`, which de-dupes via
the `inFlight` set, checks pending approvals + `shouldPauseCycle`, then
`runCycle`.

Producers today:
- `MessageService.wakeMentionedAIs` — human @mention only (`if (!user.isAI)`).
- `ApprovalService.approve` — on `PENDING → APPROVED`.

Both are human-rooted, so loops are impossible today. D2 adds an
AI-rooted producer (task handoff), which is what creates loop risk.

## 2. Phase D1 — `check_teammate_tasks` (read-only)

Mechanical, mirrors the existing tool branches.

- `lib/ai/tools/index.ts`:
  - Add `check_teammate_tasks` to `TOOL_DEFINITIONS` (8 → 9). Update the
    Property 12 reference.
  - Add Zod schema `{ aiUserId?: string; aiName?: string }` with a
    refine "at least one present".
  - Dispatcher branch: resolve the target via a new
    `TaskService.summarizeForAI(targetAiUserId)` returning counts by
    status + recent (24h) task titles; render to text. Wrap in the
    dispatcher's existing try/catch (Property 13).
- `lib/services/task.service.ts`: add `summarizeForAI(aiUserId)` —
  a workspace-scoped read (audit H4) grouping the AI's
  created/assigned tasks by status.
- Tests: target-by-id, target-by-name, unknown target → is_error,
  toolSet whitelist still gates it.

No wake, no chain — Requirement 22 is not needed for D1.

## 3. Phase D2-a — wake-chain loop prevention (the core)

### 3.1 The wake-chain context

Introduce a typed payload that travels with every wake instead of a
bare string:

```ts
// lib/loop/wake-chain.ts
export interface WakeContext {
  chainId: string;       // uuid; identifies one human-rooted chain
  hop: number;           // 0 for human-initiated, +1 per AI hop
  originUserId: string;  // the human who started the chain
}
```

The `agenticEmitter` 'wakeup' event payload becomes
`(aiUserId: string, ctx: WakeContext)`. All existing emit sites are
updated:
- Human mention → `startHumanChain(humanUserId)` → `{ chainId: uuid(),
  hop: 0, originUserId }`.
- Approval approve → same (the deciding human is the origin).
- AI handoff (D2-b) → `deriveChildContext(parentCtx)` →
  `{ chainId: parentCtx.chainId, hop: parentCtx.hop + 1, originUserId }`.

### 3.2 The gatekeeper

A single module owns the decision "may this wake proceed?":

```ts
// lib/loop/wake-chain.ts
export function authorizeWake(
  fromAiUserId: string | null,   // null = human-initiated
  toAiUserId: string,
  ctx: WakeContext,
): { ok: true } | { ok: false; reason: 'hop_budget' | 'cooldown' };
```

Rules (Req 22.2 / 22.3):
1. If `ctx.hop > AI_WAKE_MAX_HOPS` → `{ ok: false, reason: 'hop_budget' }`.
2. If `fromAiUserId !== null` and the ordered pair
   `(fromAiUserId → toAiUserId)` fired within
   `AI_WAKE_PAIR_COOLDOWN_MS` → `{ ok: false, reason: 'cooldown' }`.
3. Otherwise record the pair-fire timestamp and `{ ok: true }`.

State is a process-local `Map<string, number>` (pair → last-fire ms)
with idle eviction past the cooldown window, plus a bounded
`Map<chainId, { createdAt }>` for observability. Mirrors
`lib/ratelimit.ts`'s in-memory + sweep design (steering §8). A Redis
implementation is a noted follow-up for multi-pod (steering already
lists the Redis migration items).

### 3.3 Where the gate sits

`AgenticLoop`'s wakeup listener becomes the single chokepoint:

```ts
agenticEmitter.on('wakeup', (aiUserId, ctx) => {
  // human-rooted (hop 0) always allowed; AI-rooted goes through the gate
  const fromAi = ctx.hop > 0 ? /* carried on ctx */ : null;
  const verdict = authorizeWake(fromAi, aiUserId, ctx);
  if (!verdict.ok) {
    logger.warn({ event: `wake_suppressed_${verdict.reason}`, aiUserId, ctx });
    return;                       // suppressed — no cycle
  }
  void runForAI(aiUserId, ctx);   // ctx threaded so the cycle can derive children
});
```

`runForAI` threads `ctx` into `runCycle`, and `runCycle` makes it
available to `dispatchTool` so a handoff tool (D2-b) can derive the
child context with `hop + 1`.

### 3.4 Replacing the human-only mention guard (Req 22.5)

`MessageService.create` today:

```ts
if (!user.isAI) { void wakeMentionedAIs(content, userId, channelId); }
```

becomes:

```ts
// Human mention → start a fresh chain (hop 0).
if (!user.isAI) {
  void wakeMentionedAIs(content, userId, channelId, startHumanChain(userId));
}
// AI messages still do NOT wake from message content alone — AI→AI
// influence happens only through the explicit handoff tool (D2-b),
// which carries a wake context. This keeps "an AI mentioning another
// AI in prose" inert, exactly as today.
```

Key point: we are NOT making `@AI` in an AI's message wake anyone
(that was the dangerous line in the original proposal). AI→AI wake is
ONLY via the explicit, hop-counted handoff tool. Prose mentions stay
inert.

### 3.5 Why this is safe

- Every chain roots at a human (hop 0). AIs can only ADD hops.
- Hop budget caps the chain length to `AI_WAKE_MAX_HOPS` (default 2):
  human → Ada → Hopper, then stop.
- Per-pair cooldown stops A↔B ping-pong even within the hop budget.
- The dollar budget (M1) is the independent absolute backstop.
- No new wake producer exists except the explicit handoff tool, so the
  set of ways an AI can wake another is small and auditable.

## 4. Phase D2-b — task handoff (Req 21)

Only after §3 is merged + tested.

- New tool `assign_task` (or extend `update_task_status` with an
  `assigneeId` + wake). A dedicated `assign_task` is cleaner: it keeps
  `update_task_status`'s contract unchanged and makes the wake-bearing
  action explicit and separately whitelist-able.
- Dispatcher branch:
  1. Validate the target is an AI sharing a channel with the caller
     (Req 21.4) — reject with `is_error` otherwise.
  2. `TaskService.assign(taskId, assigneeId)` (workspace-scoped).
  3. Derive child wake context from the cycle's `ctx`
     (`deriveChildContext`), call `authorizeWake(callerAiId,
     assigneeId, childCtx)`.
  4. If `ok`, `agenticEmitter.emit('wakeup', assigneeId, childCtx)`;
     `tool_result` says "assigned + woke Hopper". If suppressed,
     `tool_result` says "assigned; wake suppressed (<reason>)" so the
     model knows not to retry.
- Role prompts (`lib/ai/prompts.ts`) extended to mention delegation
  (Property 11 preserved: still role-keyed, we edit the constant).

## 5. Testing

| Req | Test |
|---|---|
| 20 | tool resolves by id/name; unknown → is_error; whitelist gates it; summary counts correct. |
| 22.2 | hop 3 with `AI_WAKE_MAX_HOPS=2` → suppressed (`hop_budget`). |
| 22.3 | same pair twice inside cooldown → 2nd suppressed (`cooldown`). |
| 22.1/22.5 | human mention starts hop-0 chain; AI prose mention wakes no one. |
| 22.4 | dollar-budget gate still fires independently of hop budget. |
| 21 | assign to non-shared AI → is_error; successful assign emits a hop+1 wake; suppressed handoff reports reason in tool_result. |

`authorizeWake` and the chain helpers are pure/deterministic (inject a
clock for cooldown tests), so loop-prevention is unit-tested without a
live loop — the same approach used for `lib/ratelimit.ts`.

## 6. Rollout / flags

- D1: no flag needed (read-only).
- D2: gate the handoff tool behind `AI_HANDOFF_ENABLED` (default
  false) so loop prevention can soak in production with the tool
  dormant before it's switched on. The wake-chain infra (§3) is always
  active once merged (it only adds safety; with no AI producer it's
  inert).
