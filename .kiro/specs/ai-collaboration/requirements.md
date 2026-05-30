# Requirements — AI-to-AI Collaboration (direction D)

> Feature scope: turn the AI colleagues from "two independent robots"
> into a "team" — one AI can hand work to another, fan work out to
> several teammates, hand work back, and check a teammate's progress —
> WITHOUT letting AIs spiral into self-driving conversations that burn
> the budget or run unattended.
>
> This spec is split into three phases by RISK, not by feature size.
> The safe, read-only capability ships first; the autonomy-bearing
> capability ships last, gated on a loop-prevention design that is the
> real engineering content of this feature.
>
> Reference: parent specs at `.kiro/specs/ai-native-team-workspace/`
> (MVP), `.kiro/specs/phase-1-solo-os/` (Phase 1), and
> `.kiro/specs/channel-knowledge/`. All prior properties and the
> audit-derived rules in `.kiro/steering/conventions.md` remain in
> force. This document adds Requirements 20–22.

## The workflow this enables

The operator wants a *relay*, not a chat between bots:

```
human posts a need
   └─▶ AI #1 picks up the instruction and starts working
          └─▶ AI #1's result hands off to AI #2
                 └─▶ AI #2's result hands off to AI #1 / AI #3 / several
                     AIs at once (fan-out)
                        └─▶ … (bounded depth & total work) …
                               └─▶ AI #1 wraps up and reports to the human
                                      └─▶ the human decides
```

Three shapes must all be supported:

1. **Chaining** — `human → A → B → …` (a hand-off increases depth).
2. **Fan-out** — one AI's result wakes *multiple* AIs (width).
3. **Return hand-off** — `B → A` is allowed (so a teammate can hand
   work back to the originator), which is the legitimate cousin of the
   `A ⇄ B` ping-pong we must still forbid when it never terminates.

The chain ends with **AI #1 wrapping up to the human** — a normal
channel message and/or a `request_approval`. That uses the EXISTING
approval / message surface; this feature introduces no new
human-notification mechanism. Only the human's next action starts a
new chain.

## Background: the safety guard this feature must not break

`MessageService.create` deliberately fires `wakeMentionedAIs` only for
HUMAN senders:

```ts
if (!user.isAI) {
  void wakeMentionedAIs(message.content, input.userId, message.channelId);
}
```

That `if (!user.isAI)` exists specifically to prevent AI→AI mention
spirals (Ada @Hopper → Hopper @Ada → …), where every hop costs model
tokens until the daily budget breaker (audit M1) trips.

**This guard is NOT removed.** AI-authored message *content* stays
inert forever — an AI mentioning another AI in prose wakes no one. The
team-relay capability is added through a SEPARATE, controlled path: an
explicit hand-off tool that emits a wake carrying a typed
`WakeContext`, routed through a single `authorizeWake()` chokepoint
(Requirement 22). Reintroducing AI→AI wakes by deleting the
`if (!user.isAI)` guard, or by making `@mentions` in AI prose wake
anyone, is explicitly forbidden.

## Glossary additions

- **Teammate hand-off** — One AI assigns a task to another AI via the
  dedicated `assign_task` tool (Req 21), which then wakes the assignee
  through the controlled wake path. Hand-off is the ONLY way an AI can
  wake another AI.
- **Wake chain** — The causal tree of AI cycles that all trace back to
  a single originating HUMAN action. Loop prevention is enforced per
  wake chain, identified by a `chainId`.
- **Hop** — The depth of a wake within its chain. A human-initiated
  wake is `hop = 0`; each AI→AI hand-off increments `hop` by one.
- **Fan-out** — A single AI cycle issuing more than one hand-off, so
  one node in the chain has multiple children.
- **Chain activation** — Any authorized wake (human-rooted or AI-rooted)
  that actually starts a cycle. The *total* activation count across a
  chain is the real fan-out × depth budget.
- **Ordered pair** — A directed `(fromAI → toAI)` edge. The per-pair
  budget counts how many times the SAME directed edge may fire within
  ONE chain, which is what bounds `A → B → A → B …` ping-pong while
  still allowing a finite return hand-off.

---

## Requirement 20 — `check_teammate_tasks` tool (Phase D1, read-only, SAFE)

**User story**: As an operator, I want one AI to be able to check what
another AI has been doing — "Hopper, check what Ada finished today" —
so I get a synthesised status read without doing it myself.

### Acceptance criteria

- 20.1 A new read-only tool `check_teammate_tasks` is added to the
  closed tool surface. The surface grows from 8 → 9 tools; Property 12
  is amended accordingly. The mock tools remain.
- 20.2 Input: `{ aiUserId?: string, aiName?: string }`. The tool
  resolves the target AI by id or name within the active workspace.
  At least one of the two must be provided; otherwise the dispatcher
  returns `is_error: true` with a clear message.
- 20.3 Output: a concise text summary of the target AI's tasks — count
  by status (Backlog / InProgress / InReview / Done) and the titles of
  tasks updated in the last 24h. No side effects, no writes, no wakes.
- 20.4 The tool is subject to the per-AI `aiSettings.toolSet` whitelist
  (audit C4) and `dispatchTool` totality (Property 13): a failed lookup
  or unknown target resolves as `is_error`, never throws.
- 20.5 `check_teammate_tasks` does NOT charge a per-call fee (a DB read,
  free) but its model round-trips count against the budget as usual.

> Phase D1 is independently shippable and carries ZERO loop risk
> (read-only, no wake). It delivers the "Hopper checks Ada" scenario on
> its own.

---

## Requirement 21 — AI task hand-off via `assign_task` (Phase D2-b, bounded autonomy)

**User story**: As an operator, I want one AI to delegate a task to a
teammate — "Ada, assign PROJ-42 to Hopper" — and have Hopper
automatically pick it up, so work flows between AIs (chaining, fan-out,
and hand-back) without me relaying every step, while AI #1 still wraps
up to me at the end.

### Acceptance criteria

- 21.1 A NEW dedicated tool `assign_task` is added (surface grows
  9 → 10; Property 12 amended). It is the ONLY wake-bearing AI tool.
  `update_task_status` is **not** extended — keeping its contract
  unchanged and making the wake-bearing action explicit and separately
  whitelist-able (audit C4).
- 21.2 Input: `{ taskId: string, assigneeId?: string, assigneeName?: string }`
  (at least one assignee selector). The tool sets the task's
  `assigneeId` and, when the new assignee is an AI sharing a channel
  with the caller, requests a wake through the Requirement 22 wake-chain
  mechanism (hop + activation + pair bounded).
- 21.3 The `tool_result` returned to the assigning AI states explicitly
  which teammate was assigned and whether a wake was **emitted** or
  **suppressed**, including the suppression reason
  (`hop_budget` / `chain_activation_budget` / `pair_repeat_budget`),
  so the model knows not to retry a suppressed hand-off.
- 21.4 An AI may only assign to another AI that shares at least one
  channel with it (Phase 1 Req 17 membership). Cross-channel assignment
  to a non-shared AI is rejected at the tool boundary with `is_error`
  and emits no wake.
- 21.5 **Fan-out is allowed**: a single cycle MAY issue several
  `assign_task` calls (to different teammates), each producing an
  independent child wake subject to the chain budgets. **Return
  hand-off is allowed**: an AI MAY assign back to a teammate earlier in
  the chain (e.g. `B → A`), bounded by the per-pair budget (22.3) so a
  finite hand-back works but `A ⇄ B` cannot run forever.
- 21.6 The woken assignee runs a normal bounded `runCycle` with the
  inherited (hop + 1) wake context. It may itself hand off further
  (continuing the relay) or, when it is the originator wrapping up,
  report to the human via `send_channel_message` / `request_approval`.
  A plain channel message NEVER wakes anyone (the prose-mention guard
  still holds), so the relay can only continue through another explicit
  `assign_task`.
- 21.7 `assign_task` is gated behind `AI_HANDOFF_ENABLED` (default
  `false`). When disabled, the tool is absent from the surface offered
  to the model (or resolves `is_error` if called), so the wake-chain
  infrastructure can soak in production with the autonomy dormant.
- 21.8 The assigning AI's role prompt is extended to tell it that it MAY
  delegate to teammates, fan out, and hand back, and that it should wrap
  up to the human at the end (Property 11 still holds: the system prompt
  remains role-keyed; we edit the role constants, we do not inject
  per-call data into them).

---

## Requirement 22 — Wake-chain loop prevention (Phase D2-a prerequisite, the core)

**User story (operator safety)**: As an operator, I must be able to
trust that turning on AI-to-AI hand-off cannot result in AIs talking to
each other unattended until my budget is gone — even with fan-out and
hand-back enabled.

This requirement is a PREREQUISITE for Requirement 21: 21.x MUST NOT
ship without 22.x. The original "hop budget 2 + hard 60s per-pair
cooldown" was too rigid for the relay workflow (fan-out, hand-back, and
chains deeper than two). It is replaced by the parameters below.

### Acceptance criteria

- 22.1 Every wake carries a **wake-chain context**:
  `{ chainId, hop, originUserId, fromAiUserId }`. A human-initiated wake
  (mention, approval decision) starts a new chain with `hop = 0`,
  `originUserId = <the human>`, and `fromAiUserId = null`. An
  AI-initiated wake derives a child context: same `chainId`, `hop + 1`,
  same `originUserId`, and `fromAiUserId = <the assigning AI>`.

- 22.2 **Hop depth budget** (`AI_WAKE_MAX_HOPS`, default `6`): a wake
  whose `hop` would exceed the budget is SUPPRESSED — not executed —
  logged with `event: 'wake_suppressed_hop_budget'` and surfaced in the
  triggering tool's `tool_result`. The larger default (vs the original
  2) lets a real relay run several steps deep before wrapping up.

- 22.3 **Per-pair repeat budget** (`AI_WAKE_MAX_PAIR_REPEATS`, default
  `3`): within ONE chain, the same ordered `(fromAI → toAI)` edge may
  fire at most N times. The `(N+1)`th wake of that edge in the chain is
  suppressed + logged `event: 'wake_suppressed_pair_repeat'`. This
  replaces the wall-clock cooldown: it allows a legitimate finite
  hand-back / re-delegation (`A → B → A` and even a couple of rounds)
  while still stopping an unbounded `A ⇄ B` ping-pong. Because it is a
  per-chain counter (not a timer), it needs no clock and is purely
  deterministic.

- 22.4 **Chain activation budget** (`AI_WAKE_MAX_CHAIN_ACTIVATIONS`,
  default `12`): the TOTAL number of authorized wakes (activations)
  across an entire chain — counting every node in the fan-out × depth
  tree, including the hop-0 human-rooted wake(s). When the count reaches
  the cap, further wakes in that chain are suppressed + logged
  `event: 'wake_suppressed_chain_activation'`. This is the real guard
  for fan-out: hop depth alone cannot bound a wide tree, but total
  activations can.

- 22.5 **Dollar budget independence**: every cycle in a chain remains
  individually subject to `Budget.shouldPauseCycle()` (audit M1). The
  wake-chain budgets (22.2–22.4) bound the *count and shape* of cycles
  per human action; the daily USD budget remains the **independent,
  absolute** ceiling. The two are orthogonal backstops — neither
  replaces the other.

- 22.6 **Single chokepoint**: a single pure function
  `authorizeWake(fromAiUserId, toAiUserId, ctx)` is the ONLY decision
  point for "may this wake proceed?". It returns
  `{ ok: true } | { ok: false; reason: 'hop_budget' | 'pair_repeat' | 'chain_activation' }`.
  It is deterministic and unit-testable WITHOUT running a live loop
  (clock injected only for idle eviction of chain state), mirroring
  `lib/ratelimit.ts`.

- 22.7 **Prose mentions stay inert; the human-only guard is preserved.**
  AI-authored message content NEVER wakes anyone (the `if (!user.isAI)`
  guard in `MessageService.create` is kept as-is). AI→AI wakes happen
  EXCLUSIVELY through `assign_task`, which emits a wake carrying a valid
  `WakeContext`. A human mention / approval still starts a fresh chain
  at `hop = 0`.

- 22.8 Loop prevention is covered by tests that assert: a chain deeper
  than `AI_WAKE_MAX_HOPS` stops at the budget; the `(N+1)`th repeat of
  one ordered pair in a chain is suppressed while the first N succeed;
  a wide fan-out is cut off once `AI_WAKE_MAX_CHAIN_ACTIVATIONS` is
  reached; a human re-trigger starts a fresh chain (all counters reset);
  the dollar budget gate still fires independently; and an AI prose
  mention wakes no one.

- 22.9 Wake-chain state is process-local: a bounded in-memory
  `Map<chainId, ChainState>` (activations, per-pair counts, last
  activity) with idle eviction, mirroring the rate-limiter's design
  (steering §8). A Redis-backed implementation is a noted follow-up for
  multi-pod deployments.

### Out of scope (later phases)

- Agent hierarchy / org chart / manager-subordinate roles.
- Fully autonomous assignment (an AI deciding on its own with NO human
  in the originating chain) — every chain must root at a human action.
- AI-to-AI direct messaging outside channels.
- Cross-process / multi-pod shared wake-chain state (Redis).

### Cross-cutting

- New tools follow Property 12/13 and the per-AI toolSet whitelist (C4).
- New endpoints (if any) follow steering §2.
- New env vars (`AI_WAKE_MAX_HOPS`, `AI_WAKE_MAX_PAIR_REPEATS`,
  `AI_WAKE_MAX_CHAIN_ACTIVATIONS`, `AI_HANDOFF_ENABLED`) land in
  `.env.example` + `.env.production.example` + `LAUNCH_CHECKLIST.md`.
  The old `AI_WAKE_PAIR_COOLDOWN_MS` is NOT introduced (removed from the
  design before any code shipped).
- Every phase ships with tests; Phase D2-a cannot merge without the
  Requirement 22 loop-prevention tests green, and Phase D2-b cannot
  merge before D2-a.
