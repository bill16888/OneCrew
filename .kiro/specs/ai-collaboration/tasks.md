# Tasks — AI-to-AI Collaboration (direction D)

> Three phases, shipped as separate PRs in this order. D2-b MUST NOT
> merge before D2-a. Each PR branches from the latest merged `main`
> (steering §12). Follow `.kiro/steering/conventions.md`.

## Phase D1 — `check_teammate_tasks` (read-only, SAFE) — PR 1

- [ ] D1.1 `TaskService.summarizeForAI(aiUserId)`: workspace-scoped
  read; counts by status + last-24h task titles. Add the matching
  prisma mock in the test file (steering §9).
- [ ] D1.2 `lib/ai/tools/index.ts`: add `check_teammate_tasks` to
  `TOOL_DEFINITIONS` (8→9) + Zod `{ aiUserId?, aiName? }` (refine: at
  least one) + dispatcher branch resolving target by id or name within
  workspace; render summary text.
- [ ] D1.3 Update Property 12 closed-set test (8→9).
- [ ] D1.4 Role prompts: tell AIs they can check a teammate's work
  (edit role constants; Property 11 stays role-keyed).
- [ ] D1.5 Tests: resolve-by-id, resolve-by-name, missing-selector
  →is_error, unknown→is_error, toolSet whitelist still gates, summary
  counts.

## Phase D2-a — wake-chain loop prevention (safety infra) — PR 2

- [ ] D2a.1 `lib/loop/wake-chain.ts`:
  - `WakeContext` type `{ chainId, hop, originUserId, fromAiUserId }`.
  - `startHumanChain(humanUserId)` → hop-0 context (fromAiUserId null).
  - `deriveChildContext(parent, callerAiUserId)` → same chainId,
    hop+1, fromAiUserId = caller.
  - `authorizeWake(fromAiUserId, toAiUserId, ctx, now?)` returning
    `{ ok } | { ok:false, reason: 'hop_budget' | 'pair_repeat' | 'chain_activation' }`,
    with hop-depth + per-pair-per-chain + chain-activation budgets,
    in-memory `Map<chainId, ChainState>` ({ activations, pairCounts,
    lastActivityAt }), idle eviction via `CHAIN_IDLE_TTL_MS` constant,
    `__resetForTests()`.
- [ ] D2a.2 `lib/env.ts`: `AI_WAKE_MAX_HOPS` (default 6),
  `AI_WAKE_MAX_PAIR_REPEATS` (default 3),
  `AI_WAKE_MAX_CHAIN_ACTIVATIONS` (default 12). (Do NOT add
  `AI_WAKE_PAIR_COOLDOWN_MS` — superseded by the per-pair counter.)
- [ ] D2a.3 Change `agenticEmitter` 'wakeup' payload to
  `(aiUserId, ctx: WakeContext)` in `lib/loop/emitter.ts`. Update ALL
  emit sites: `MessageService.wakeMentionedAIs` (one
  `startHumanChain(senderId)` context reused for every matched AI),
  `ApprovalService.approve` (→ startHumanChain for the decider).
- [ ] D2a.4 `lib/loop/agentic-loop.ts` wakeup listener: run
  `authorizeWake` as the single chokepoint; suppress + log
  `wake_suppressed_<reason>` on deny; thread `ctx` into
  `runForAI(aiUserId, ctx)` → `runCycle`. Keep the existing inFlight /
  pending-approval / `shouldPauseCycle` gates after authorization.
- [ ] D2a.5 Keep AI prose mentions inert: the `if (!user.isAI)` guard
  in `MessageService.create` stays verbatim. No else branch. Only human
  mentions / approvals start chains.
- [ ] D2a.6 Tests (the gate, clock injected only for eviction):
  hop-depth stop, per-pair repeat stop (first N succeed, N+1
  suppressed, fresh chain resets), fan-out chain-activation stop,
  human-starts-hop-0-chain, dollar-budget independence, AI-prose-mention
  wakes no one, idle eviction.
- [ ] D2a.7 Docs: new env vars in `.env.example` /
  `.env.production.example` / `LAUNCH_CHECKLIST.md`.

## Phase D2-b — `assign_task` hand-off (bounded autonomy) — PR 3 (gated on D2-a)

- [ ] D2b.1 `TaskService.assign(taskId, assigneeId)` (workspace-scoped;
  broadcasts `task:updated` post-commit). Add prisma mock in tests.
- [ ] D2b.2 New tool `assign_task` in `TOOL_DEFINITIONS` (9→10) + Zod
  `{ taskId, assigneeId?, assigneeName? }` (refine: at least one
  assignee) + dispatcher branch: resolve assignee, validate it is an AI
  sharing a channel with the caller (Req 21.4) else is_error + no wake;
  `TaskService.assign`; derive child ctx; `authorizeWake`; emit hop+1
  wake or report suppression reason in `tool_result`.
- [ ] D2b.3 Thread the cycle's `WakeContext` into `dispatchTool` (via
  `ToolDispatchContext`) so the hand-off branch can derive the child
  context. Fan-out (multiple assign_task calls) and hand-back (target
  an earlier AI) need no extra code beyond the per-call gate.
- [ ] D2b.4 Role prompts: tell AIs they may delegate, fan out, hand
  back, and that AI #1 should wrap up to the human at the end.
- [ ] D2b.5 `AI_HANDOFF_ENABLED` flag (default false) gating the tool
  (absent from the offered surface / is_error when off).
- [ ] D2b.6 Property 12 closed-set test (9→10).
- [ ] D2b.7 Tests: assign-to-non-shared→is_error + no wake; successful
  assign emits hop+1 wake; suppressed hand-off reports reason; fan-out
  to several teammates; hand-back bounded by per-pair budget; assignee
  acknowledgement (plain message) re-wakes no one; flag-off disables.

## Out of scope (later)

- Agent hierarchy / manager roles.
- Redis-backed wake-chain state for multi-pod.
- AI-to-AI DMs outside channels.
- Fully autonomous (non-human-rooted) chains.
