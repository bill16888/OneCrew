# Requirements — AI-to-AI Collaboration (direction D)

> Feature scope: turn the AI colleagues from "two independent robots"
> into a "team" — one AI can hand work to another and check a
> teammate's progress — WITHOUT letting AIs spiral into self-driving
> conversations that burn the budget or run unattended.
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

## Background: the safety guard this feature must not break

`MessageService.wakeMentionedAIs` deliberately fires only for HUMAN
senders:

```ts
if (!user.isAI) {
  void wakeMentionedAIs(message.content, input.userId, message.channelId);
}
```

That `if (!user.isAI)` exists specifically to prevent AI→AI mention
spirals (Ada @Hopper → Hopper @Ada → …), where every hop costs model
tokens until the daily budget breaker (audit M1) trips. Any feature
that lets one AI wake another MUST reintroduce that wake path WITH a
bounded loop-prevention mechanism (Requirement 22). Removing the guard
without that mechanism is explicitly forbidden.

## Glossary additions

- **Teammate handoff** — One AI assigns a task to another AI (via
  `update_task_status`/assignment) which then wakes the assignee.
- **Wake chain** — The causal chain of AI cycles that all trace back
  to a single originating HUMAN action. Loop prevention is enforced
  per wake chain.
- **Hop** — One AI→AI wake within a wake chain. The chain carries a
  hop counter; exceeding the hop budget stops further waking.

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

## Requirement 21 — AI task handoff (Phase D2, bounded autonomy)

**User story**: As an operator, I want to tell one AI to delegate a
task to another — "Ada, assign PROJ-42 to Hopper" — and have Hopper
automatically pick it up and acknowledge, so work flows between AIs
without me relaying it.

### Acceptance criteria

- 21.1 `update_task_status` (and/or a dedicated assignment path) gains
  the ability to set `assigneeId`. When the new assignee is an AI that
  is a member of a relevant channel, the assignee is woken — but ONLY
  through the wake-chain mechanism of Requirement 22 (hop-bounded).
- 21.2 The `tool_result` returned to the assigning AI states explicitly
  which teammate was assigned and whether a wake was emitted or
  suppressed (e.g. "assigned to Hopper; wake suppressed: hop budget
  exhausted").
- 21.3 The woken assignee runs a normal bounded `runCycle`; it is
  expected (via system prompt) to acknowledge in the channel. Its
  acknowledgement message does NOT itself wake anyone unless it
  contains a fresh human-initiated condition — which by construction it
  cannot, because the wake chain originated from a human and the hop
  counter only increases.
- 21.4 An AI may only assign to another AI that shares at least one
  channel with it (Phase 1 Req 17 membership). Cross-channel assignment
  to a non-shared AI is rejected at the tool boundary with `is_error`.
- 21.5 The assigning AI's system prompt is updated to tell it that it
  MAY delegate to teammates and how (Property 11 still holds: the
  system prompt remains role-keyed; we extend the role prompts, we do
  not inject per-call data into them).

---

## Requirement 22 — Wake-chain loop prevention (Phase D2 prerequisite, the core)

**User story (operator safety)**: As an operator, I must be able to
trust that turning on AI-to-AI handoff cannot result in two AIs talking
to each other unattended until my budget is gone.

This requirement is a PREREQUISITE for Requirement 21: 21.x MUST NOT
ship without 22.x.

### Acceptance criteria

- 22.1 Every wake carries a **wake-chain context**:
  `{ chainId, hop, originUserId }`. A human-initiated wake (mention,
  approval decision) starts a new chain with `hop = 0` and
  `originUserId = <the human>`. An AI-initiated wake increments `hop`.
- 22.2 **Hop budget**: a configurable maximum hop count
  (`AI_WAKE_MAX_HOPS`, default `2`). A wake that would exceed the
  budget is SUPPRESSED — not executed — and the suppression is logged
  with `event: 'wake_suppressed_hop_budget'` and surfaced in the
  triggering tool's `tool_result`.
- 22.3 **Per-pair cooldown**: the same ordered `(fromAI, toAI)` pair
  cannot wake again within a cooldown window
  (`AI_WAKE_PAIR_COOLDOWN_MS`, default `60000`). A wake inside the
  cooldown is suppressed + logged `event: 'wake_suppressed_cooldown'`.
- 22.4 **Chain budget tie-in**: all cycles in one wake chain are still
  individually subject to `Budget.shouldPauseCycle()` (audit M1). The
  hop budget bounds the COUNT of AI cycles per human action; the dollar
  budget remains the absolute ceiling. The two are independent
  backstops.
- 22.5 The existing human-only mention guard
  (`if (!user.isAI)` in `MessageService.create`) is REPLACED by a
  guard that allows AI-initiated wakes ONLY when they carry a valid,
  non-exhausted wake-chain context. A bare AI message with no chain
  context (e.g. an AI's spontaneous channel post) still does NOT wake
  anyone — preserving today's behaviour for the no-chain case.
- 22.6 Loop prevention is covered by tests that assert: a 3-hop chain
  with budget 2 stops at hop 2; a rapid second wake of the same pair is
  suppressed by cooldown; a human re-trigger starts a fresh chain
  (hop resets); the dollar budget gate still fires independently.
- 22.7 Wake-chain state is process-local (a bounded in-memory map keyed
  by chainId, with idle eviction) for the single-process MVP, mirroring
  the rate-limiter's design. A Redis-backed implementation is a noted
  follow-up for multi-pod deployments.

### Out of scope (later phases)

- Agent hierarchy / org chart / manager-subordinate roles.
- Fully autonomous assignment (AI deciding on its own, with no human in
  the originating chain) — every chain must root at a human action.
- AI-to-AI direct messaging outside channels.

### Cross-cutting

- New tools follow Property 12/13 and the per-AI toolSet whitelist.
- New endpoints (if any) follow steering §2.
- New env vars (`AI_WAKE_MAX_HOPS`, `AI_WAKE_PAIR_COOLDOWN_MS`) land in
  `.env.example` + `.env.production.example` + `LAUNCH_CHECKLIST.md`.
- Every phase ships with tests; Phase D2 cannot merge without the
  Requirement 22 loop-prevention tests green.
