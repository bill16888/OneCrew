# Requirements — Channel Knowledge Cards

> Feature scope: give each channel a human-editable "knowledge card"
> that AI colleagues read automatically, so an AI's replies reflect
> the actual project (repo, stack, current sprint, who's who) instead
> of being a generic assistant.
>
> This is the "cognitive external brain" MVP (direction A). It is
> deliberately the *manual-edit, passive-read* version: no vector
> retrieval, no auto-extraction — those are a later phase.
>
> Reference: parent specs at
> `.kiro/specs/ai-native-team-workspace/` (MVP) and
> `.kiro/specs/phase-1-solo-os/` (Phase 1). All prior properties and
> the audit-derived rules in `.kiro/steering/conventions.md` remain in
> force. This document adds Requirement 19.

## Glossary additions

- **Knowledge card** — A single Markdown text blob attached to a
  channel (`Channel.knowledge`). Free-form; the product does not
  impose structure, though the UI suggests a template.
- **Knowledge injection** — The runtime step that folds the relevant
  channel knowledge into an AI cycle's initial context so the model
  reads it before acting.

---

## Requirement 19 — Channel knowledge cards

**User story**: As an operator, I want to write down what a channel is
about — the repo, the database, the current sprint, who owns what —
once, and have my AI colleagues automatically read it before they
respond, so their answers are grounded in my actual project instead of
generic guesses.

### Acceptance criteria — data

- 19.1 The `Channel` model gains an optional `knowledge` text field
  (`String?`, mapped to Postgres `TEXT`). Existing channels migrate
  with `knowledge = NULL` (no backfill needed; null means "no card").
- 19.2 A knowledge card is capped at 8,000 characters (UTF-16 code
  units), mirroring the message-content cap so a single card cannot
  dominate the AI context budget. Writes exceeding the cap are
  rejected with a validation error; nothing is persisted.

### Acceptance criteria — API

- 19.3 `GET /api/channels/[channelId]/knowledge` returns
  `{ content: string | null }` for a channel in the active workspace.
  Requires a session; 404 when the channel is not in the workspace.
- 19.4 `PUT /api/channels/[channelId]/knowledge` with body
  `{ content: string }` replaces the card. Requires a session; rate-
  limited via `RateLimits.WRITE`; 404 for cross-workspace channels;
  400 when `content` is not a string or exceeds the 8,000-char cap.
  An empty string clears the card (stored as `''`, distinct from
  `NULL` only in that the operator explicitly emptied it — both read
  as "no usable knowledge" by the runtime).
- 19.5 Both verbs enforce the workspace boundary (audit H4) and return
  the canonical `{ error }` envelope on failure.

### Acceptance criteria — AI runtime injection

- 19.6 Before an AI cycle issues its first model call, the runtime
  collects the knowledge cards of the channels the AI is a **member**
  of (Phase 1 Req 17 membership) and folds them into the cycle's
  **initial user context** — NOT the system prompt. Putting it in the
  system prompt would violate Property 11 (role-keyed system prompt);
  the knowledge therefore rides in `buildInitialContext` alongside the
  recent-activity digest, exactly like the daily-report
  `extraInstruction`.
- 19.7 Only non-empty cards are injected. Channels with `NULL`/empty
  knowledge contribute nothing. Each injected card is labelled with
  its channel name so the model can attribute facts to the right
  channel.
- 19.8 The combined injected knowledge is bounded: the total knowledge
  text folded into one cycle is capped (default 12,000 chars across
  all the AI's channels) and is subject to the existing
  `trimContextToTokenBudget` so a large set of cards can never starve
  the recent-activity digest or the model's response budget.
- 19.9 Knowledge injection changes only the context content. It does
  NOT change the closed tool surface (Property 12), the dispatcher
  totality (Property 13), the budget gate, or the `ai:thinking`
  contract.

### Acceptance criteria — UI

- 19.10 The channel view shows a collapsible "knowledge card" region
  at the top of the channel. Collapsed by default if a card exists
  (shows a one-line summary); expandable to view/edit.
- 19.11 An operator can edit the card in a Markdown textarea and save;
  the save calls `PUT .../knowledge`. A character counter shows
  remaining capacity against the 8,000 cap.
- 19.12 AI messages that ran a cycle which injected knowledge show a
  small "已读取频道知识" affordance. (Best-effort: if surfacing this
  per-message proves costly it may ship as a follow-up; the data +
  injection in 19.6–19.8 are the core requirement.)

### Out of scope (later phases)

- Vector retrieval / semantic search over knowledge.
- Auto-extraction of knowledge from conversation.
- Per-card versioning / edit history.
- Rich structured fields (the card is free-form Markdown).

### Cross-cutting

- New API endpoints follow steering §2 (requireSession +
  enforceRateLimit + Zod) and §3 (workspace boundary).
- New env vars (if any) land in `.env.example`. The knowledge cap and
  injection cap are constants, not env-configurable, in this MVP.
- Ships with tests for: the cap validation, the workspace-boundary
  404, and the runtime injection (non-empty cards folded, empty/NULL
  skipped, total bounded).
