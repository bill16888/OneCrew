# Tasks — AI-to-AI Collaboration (direction D)

> Three phases, shipped as separate PRs in this order. D2-b MUST NOT
> merge before D2-a. Follow `.kiro/steering/conventions.md`.

## Phase D1 — `check_teammate_tasks` (read-only, SAFE) — PR 1

- [ ] D1.1 `TaskService.summarizeForAI(aiUserId)`: workspace-scoped
  read; counts by status + last-24h task titles.
- [ ] D1.2 `lib/ai/tools/index.ts`: add `check_teammate_tasks` to
  `TOOL_DEFINITIONS` (8→9) + Zod `{ aiUserId?, aiName? }` (refine: at
  least one) + dispatcher branch resolving target by id or name within
  workspace; render summary text.
- [ ] D1.3 Update Property 12 closed-set test (8→9).
- [ ] D1.4 Role prompts: tell AIs they can check a teammate's work.
- [ ] D1.5 Tests: resolve-by-id, resolve-by-name, unknown→is_error,
  toolSet whitelist still gates, summary counts.

## Phase D2-a — wake-chain loop prevention (safety infra) — PR 2

- [ ] D2a.1 `lib/loop/wake-chain.ts`: `WakeContext` type,
  `startHumanChain(userId)`, `deriveChildContext(parent)`,
  `authorizeWake(fromAi, toAi, ctx)` with hop-budget + per-pair
  cooldown, in-memory state + idle sweep, `__resetForTests`.
- [ ] D2a.2 `lib/env.ts`: `AI_WAKE_MAX_HOPS` (default 2),
  `AI_WAKE_PAIR_COOLDOWN_MS` (default 60000).
- [ ] D2a.3 Change `agenticEmitter` 'wakeup' payload to
  `(aiUserId, ctx: WakeContext)`. Update ALL emit sites:
  `MessageService` (human mention → startHumanChain),
  `ApprovalService.approve` (→ startHumanChain for the decider).
- [ ] D2a.4 `AgenticLoop` wakeup listener: run `authorizeWake` as the
  single chokepoint; suppress + log on deny; thread `ctx` into
  `runForAI` → `runCycle`.
- [ ] D2a.5 Keep AI prose mentions inert (do NOT wake from AI message
  content). Only human mentions start chains.
- [ ] D2a.6 Tests (the gate): hop-budget stop, pair cooldown,
  human-resets-chain, dollar-budget independence, AI-prose-mention
  wakes no one. (clock injected for determinism)
- [ ] D2a.7 Docs: new env vars in `.env.example` /
  `.env.production.example` / `LAUNCH_CHECKLIST.md`.

## Phase D2-b — task handoff (bounded autonomy) — PR 3 (gated on D2-a)

- [ ] D2b.1 `TaskService.assign(taskId, assigneeId)` (workspace-scoped).
- [ ] D2b.2 New tool `assign_task` in `TOOL_DEFINITIONS` (9→10) + Zod +
  dispatcher branch: validate target is an AI sharing a channel with
  the caller (Req 21.4); assign; derive child ctx; `authorizeWake`;
  emit hop+1 wake or report suppression in `tool_result`.
- [ ] D2b.3 Thread the cycle's `WakeContext` into `dispatchTool` so the
  handoff branch can derive the child context.
- [ ] D2b.4 Role prompts: tell AIs they may delegate to teammates and
  how.
- [ ] D2b.5 `AI_HANDOFF_ENABLED` flag (default false) gating the tool.
- [ ] D2b.6 Property 12 closed-set test (9→10).
- [ ] D2b.7 Tests: assign-to-non-shared→is_error; successful assign
  emits hop+1 wake; suppressed handoff reports reason; assignee
  acknowledges without re-waking.

## Out of scope (later)

- Agent hierarchy / manager roles.
- Redis-backed wake-chain state for multi-pod.
- AI-to-AI DMs outside channels.
- Fully autonomous (non-human-rooted) chains.
