# Requirements — Phase 1: Solo Operator OS

> Phase scope: turn the post-audit MVP from "AI chat toy" into
> "single-operator command center where AI does real work and the
> human stays in the loop."
>
> Reference: parent spec at `.kiro/specs/ai-native-team-workspace/`.
> All MVP requirements (1.x – 10.x) remain in force; this document
> only adds new requirements (12.x – 18.x). Numbering skips 11.x to
> reserve room for any retroactive amendments to the MVP spec.

## Glossary additions

- **Real tool** — A `request_approval`-eligible AI tool whose
  side effect leaves the process (HTTP call to a third-party API,
  GitHub commit, etc.) and whose result depends on external state.
  Distinct from **mock tool** (`mock_web_search` /
  `mock_read_project_docs`) which the MVP keeps as Property 14
  ("纯净性") guarantees.
- **Operator** — The single human user who owns the workspace. The
  Phase 1 product is built for an operator running a one-person
  business or solo project; multi-tenancy is out of scope until
  Phase 3.
- **Daily report** — An automated, end-of-day digest each AI emits
  to the workspace's primary channel summarising what it did,
  what's blocked, and what's next.
- **Dashboard** — The new `/dashboard` route that becomes the
  workspace landing page after sign-in (replacing the current
  redirect to a channel).

---

## Requirement 12 — Real read-only tools (web_search, read_project_docs)

**User story**: As an operator, I want my AI colleagues to read live
information from the public web and from my GitHub repositories, so
that their suggestions reflect today's reality and not a frozen
snapshot from training time.

### Acceptance criteria

- 12.1 The runtime exposes two new tools to every AI cycle alongside
  the existing 6: `web_search`, `read_project_docs`. Property 12 is
  amended to read "exactly the 8 tools declared in TOOL_DEFINITIONS".
  The mock variants (`mock_web_search`, `mock_read_project_docs`)
  remain in the surface for tests and offline mode.
- 12.2 `web_search({ query, maxResults? })` MUST issue a single
  outbound HTTPS request to a configured search provider (Tavily by
  default; pluggable per Requirement 14) and return at most
  `maxResults ?? 5` rows of `{ title, url, snippet }` rendered as
  markdown.
- 12.3 `read_project_docs({ owner, repo, path, ref? })` MUST fetch
  the file at `path` from `github.com/{owner}/{repo}` at the given
  `ref` (defaulting to the repo's default branch). The response is
  the file's UTF-8 contents, capped at 64 KB. Files larger than the
  cap return a truncation marker explaining how to refine the path.
- 12.4 Both tools fail closed: missing API key, network timeout
  (≥ 8 s), 4xx/5xx responses, and parse errors all resolve as
  `tool_result { is_error: true, content: '<safe message>' }`. The
  AI cycle continues; the runtime never throws.
- 12.5 Either tool can be disabled per-AI via the existing
  `aiSettings.toolSet` whitelist (Audit C4). When the operator
  removes `web_search` from a custom AI's toolset, that AI sees
  the same "Tool not enabled" rejection that other restricted tools
  produce today.
- 12.6 Both tools count toward the daily AI USD budget tracker. A
  configurable per-call cost (default `$0.001` for web_search,
  `$0.0` for read_project_docs since GitHub Contents is free under
  rate limit) is added to the budget on each successful call.

---

## Requirement 13 — Operator dashboard at `/dashboard`

**User story**: As an operator, I want a single "command center" page
that shows me the day's state at a glance — what AIs did, what's
blocked on me, where the time went — so I don't have to dig through
channels to feel oriented.

### Acceptance criteria

- 13.1 After sign-in, the workspace root (`/`) redirects to
  `/dashboard` instead of the first channel. Direct deep links to
  `/channels/{id}` and `/board` keep working unchanged.
- 13.2 The dashboard renders four panels above the fold on desktop
  (≥ 1280 px wide):
  - **Today's pulse** — counts of messages sent / tasks completed /
    approvals decided in the last 24 h (broken down by human vs AI).
  - **AI status** — one card per AI: name, current `aiStatus`,
    last cycle's `finishReason`, and the `ai:thinking` indicator.
  - **Pending approvals** — every approval with `status === 'PENDING'`,
    sorted by `createdAt` ascending, with inline approve / reject
    buttons.
  - **Recent activity** — last 20 events across messages, task
    transitions, and approvals, rendered as a vertical timeline.
- 13.3 The dashboard subscribes to the same realtime channels the
  rest of the UI uses (`workspace:{id}`, plus per-channel rooms
  it surfaces). Updates land in < 1 s end-to-end (Property 26
  ceiling, unchanged).
- 13.4 Operators on viewports < 1024 px wide see the four panels
  stacked vertically in the order above. The mobile header
  (existing) remains.
- 13.5 The dashboard panel data fetches MUST be authenticated (the
  middleware already enforces `/api/*` 401 per Audit H3) and rate
  limited via the existing `RateLimits.READ_HEAVY` bucket.

---

## Requirement 14 — Pluggable AI backend providers

**User story**: As an operator, I want to choose which model provider
to bill against (Anthropic, DeepSeek, OpenAI, or a local LLM) without
changing application code, so I can use the model my employer trusts
and the rate I can afford.

### Acceptance criteria

- 14.1 `AI_PROVIDER` env var selects the active provider; supported
  values for Phase 1 are `deepseek` (current default), `anthropic`,
  and `openai`. Future providers (`ollama`, `azure-openai`) are out
  of scope but the abstraction MUST not preclude them.
- 14.2 Switching providers requires only env-var changes
  (`AI_PROVIDER`, the matching `<PROVIDER>_API_KEY`,
  optionally `<PROVIDER>_BASE_URL`); no code change. The runtime
  reads these on boot via `lib/env.ts`.
- 14.3 All four MVP invariants survive the swap:
  - Property 11 (Role-keyed system prompt)
  - Property 12 (closed tool surface — now 8 tools per Req 12.1)
  - Property 13 (dispatcher totality)
  - Property 28 (bounded retry / 1+3 attempts)
- 14.4 Pricing for the budget tracker (Audit L1) is per-provider:
  `<PROVIDER>_INPUT_PRICE_PER_M_USD` /
  `<PROVIDER>_OUTPUT_PRICE_PER_M_USD`. Missing entries fall back to
  a conservative default that biases the breaker toward tripping
  early.

---

## Requirement 15 — AI daily report

**User story**: As an operator who logs off at 18:00 and signs back
in at 08:00, I want a daily digest from each AI in `#general`
explaining what they did, what's stuck, and what they propose for
tomorrow, so I can resume context in 30 seconds instead of
re-reading every channel.

### Acceptance criteria

- 15.1 A new `lib/reports/daily.ts` module schedules an end-of-day
  job. Default cron: `0 18 * * *` in the workspace's configured TZ
  (`WORKSPACE_TZ`, default `Asia/Shanghai`). Configurable via
  `DAILY_REPORT_CRON` env var.
- 15.2 For each `User { isAI: true, aiStatus: 'active' }`, the
  scheduler runs one bounded `runCycle` with a system instruction
  asking the AI to produce a structured daily report and call
  `send_channel_message` to `#general` (or the workspace's primary
  channel if `#general` is absent).
- 15.3 Daily-report cycles are bounded by the same MAX_ROUNDS
  (5) and AI USD budget gate as ordinary cycles. They MUST NOT
  bypass `Budget.shouldPauseCycle()` (Audit M1).
- 15.4 The report message metadata MUST include
  `{ event: 'daily_report' }` so the dashboard's "Recent activity"
  panel (Req 13.2) can render it with a distinct visual treatment.
- 15.5 If an AI's daily-report cycle fails (retry exhausted, budget
  exceeded), the failure is logged via pino with
  `event: 'daily_report_failed'` AND the AI's status indicator on
  the dashboard surfaces the failure. The scheduler does NOT retry
  within the same day (operator can manually trigger via UI).
- 15.6 An operator can manually trigger a daily report for any AI
  from the dashboard's AI-status card. Manual triggers are rate
  limited per-AI (1/min) and produce identical output structure.

---

## Requirement 16 — Brand decoupling

**User story**: As the maintainer of this codebase, I want every
user-visible string and seeded fixture to use a brand the operator
controls, so I can deploy this product without legal risk and with
my own identity.

### Acceptance criteria

- 16.1 All seeded user-visible strings are read from env vars with
  generic defaults:
  - `WORKSPACE_NAME` (default `My Workspace`)
  - `AI_AGENT_NAMES_JSON` (default `[{"name":"Architect","role":"engineer"},{"name":"Coordinator","role":"pm"}]`)
  - The development `OneCrew Demo Workspace` string and `Ada` / `Hopper`
    seeds still seed when the env vars are unset, **but only in
    development mode** (`NODE_ENV !== 'production'`).
- 16.2 `MENTION_ALIASES` (Chinese transliterations) is no longer
  hard-coded for `Ada` / `Hopper`. The seed populates each AI's
  `aiSettings.mentionAliases` with reasonable defaults if the env
  var doesn't supply them; existing logic from Audit H1 already
  consumes `aiSettings.mentionAliases`.
- 16.3 Every README / documentation occurrence of the old workspace brand
  is updated to the configurable workspace name OR replaced with a
  neutral phrase. The single exception is historical context inside
  audit / spec markdown.
- 16.4 The login page header reads from `WORKSPACE_NAME`. Tailwind
  brand color (`--brand`) is exposed as a CSS variable so an
  operator can override without touching component code.

---

## Requirement 17 — Channel membership

**User story**: As an operator with multiple channels, I want to
control which AIs participate in which channels, so my engineering
AI doesn't see my marketing channel and vice versa.

### Acceptance criteria

- 17.1 New `ChannelMember` table:
  `(channelId, userId, role: 'human' | 'ai', joinedAt)`. Existing
  channels grandfather every workspace user into membership at
  migration time so legacy behaviour is preserved.
- 17.2 `MessageService.create` enforces channel membership: if the
  sender is not a member, return `ValidationError('not a member of
  this channel')`. The realtime broadcast is unchanged but only
  hits the room — and the room only contains member sockets.
- 17.3 `wakeMentionedAIs` (Audit H1, M3) only emits `wakeup` for
  AIs that are members of the channel where the mention appeared.
  An `@AI` for an AI that's not in the channel returns a
  best-effort system message ("Architect is not in this channel").
- 17.4 The dashboard's AI-status card (Req 13.2) lists the channels
  each AI is a member of.
- 17.5 The channel header gains an "Add AI" / "Remove AI" affordance
  for the operator. Adding an AI is rate-limited via
  `RateLimits.WRITE`.

---

## Requirement 18 — Notifications

**User story**: As an operator who runs the workspace in a browser
tab while doing other work, I want desktop notifications when an AI
needs my decision or finishes a cycle that produced output, so I
don't have to keep the tab in the foreground.

### Acceptance criteria

- 18.1 The first time an operator signs in after this feature ships,
  a banner asks for browser-Notification permission. The banner is
  dismissible; dismissal persists in localStorage.
- 18.2 With permission granted, the client emits a desktop
  notification when:
  - A new approval transitions to PENDING for an AI in any channel
    the operator is a member of.
  - A `task:updated` event moves a task to `Done` if the operator
    is the task's `creatorId`.
  - The AI budget breaker trips (Audit M1).
- 18.3 Notifications are throttled client-side: at most one per
  category per minute. Throttled events are batched into a single
  "N updates" notification.
- 18.4 The notification's `tag` is set so a second notification of
  the same kind replaces the first instead of stacking.
- 18.5 Clicking a notification focuses the browser tab AND
  navigates to the relevant view (channel for messages, board for
  tasks, dashboard for budget).

---

## Cross-cutting non-functional requirements

- **Performance**: dashboard initial load < 2 s on a P99 cold
  cache. Daily-report cycles MUST complete within MAX_ROUNDS × the
  per-round timeout configured in `lib/ai/anthropic.ts`.
- **Backwards compatibility**: every Phase 1 feature preserves
  every MVP property and every audit-derived rule in
  `.kiro/steering/conventions.md`. New endpoints follow §2 of the
  conventions (requireSession + enforceRateLimit + Zod).
- **Documentation**: each new env var lands in
  `.env.example`, `.env.production.example`, and
  `LAUNCH_CHECKLIST.md`. New lib/* helpers register in §10 of the
  steering conventions.
- **Testing**: each new requirement ships with at least one
  property-based or integration test. Audit must-fix coverage
  added in PR #9 is not regressed.
