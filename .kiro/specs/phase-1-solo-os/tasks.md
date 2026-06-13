# Tasks — Phase 1: Solo Operator OS

> Implementation plan derived from `requirements.md` and `design.md`
> in this directory. Tasks are ordered by the rollout sequence in
> design.md §10 — pick the next unchecked task and work top-down.
>
> Conventions to follow on every task: `.kiro/steering/conventions.md`.

## Sprint 0 — Pre-flight (this PR)

- [x] **0.1** Spec drafted (`requirements.md`, `design.md`, `tasks.md`).
- [ ] **0.2** Open the spec PR for review (this PR). Once merged,
  every Phase 1 task PR can reference an `#[[file:.kiro/specs/phase-1-solo-os/...]]` include without 404.

---

## Sprint 1 — Real read-only tools (Req 12)

> Goal: ship the first user-visible Phase 1 win — AIs read live web
> + GitHub. Demoable in a video by end of sprint.

- [ ] **1.1** Add `lib/ai/tools/web-search.ts` with the Tavily
  adapter (default) + Serper adapter (fallback). Each adapter
  exports `searchWeb(query, options): Promise<SearchResult[]>`.
  Validates Req 12.2.
- [ ] **1.2** Add `lib/ai/tools/project-docs.ts` calling the GitHub
  Contents API. Handle file / dir / 404 / 403 / rate-limit. Cap
  body at 64 KB. Validates Req 12.3.
- [ ] **1.3** Extend `TOOL_DEFINITIONS` (lib/ai/tools/index.ts) from
  6 → 8 entries. Update Property 12 reference in the file's
  JSDoc. Add the two Zod schemas to `TOOL_ZOD_SCHEMAS`. Wire the
  dispatcher branches.
- [ ] **1.4** Add `withSafeExecution` shared helper for timeout +
  is_error envelope (design §2.4). Use it from both new tools.
- [ ] **1.5** Add `Budget.trackOther(usd, source)` for non-token
  costs. Wire `web_search` to charge `WEB_SEARCH_COST_USD` (env,
  default 0.001). Validates Req 12.6.
- [ ] **1.6** Add env vars: `TAVILY_API_KEY`, `SERPER_API_KEY`,
  `WEB_SEARCH_PROVIDER` (default `tavily`), `GITHUB_TOKEN`,
  `WEB_SEARCH_COST_USD`. Update `lib/env.ts` zod schema,
  `.env.example`, `.env.production.example`,
  `LAUNCH_CHECKLIST.md`.
- [ ] **1.7** Tests: property test for is_error invariant under
  malformed provider responses; unit tests for size cap,
  dir-vs-file branching, per-AI toolSet whitelist still rejects
  these new tools. Aim for ≥ 8 new tests.

---

## Sprint 2 — Dashboard (Req 13)

> Goal: when an operator signs in, the first thing they see is
> "what happened today" — not an empty channel.

- [ ] **2.1** Create `app/(workspace)/dashboard/page.tsx` skeleton
  with the four-panel grid. Behind a feature flag
  `DASHBOARD_ENABLED` for safe rollout.
- [ ] **2.2** Implement `app/api/dashboard/summary/route.ts` with the
  consolidated read (design §3.1). Auth + `RateLimits.READ_HEAVY`.
- [ ] **2.3** Build the four panel components in
  `app/(workspace)/dashboard/_components/`. Each is a pure render
  given props from the summary endpoint.
- [ ] **2.4** Wire realtime: subscribe to `workspace:{id}` plus the
  operator's channels on mount; patch summary state on incoming
  events. Unsubscribe on unmount.
- [ ] **2.5** Update `app/(workspace)/page.tsx` to redirect to
  `/dashboard` (or to the channel for users with
  `DASHBOARD_ENABLED=false` for the rollout window).
- [ ] **2.6** Mobile layout (≥ 1024 px stacks vertically). Manual
  test on a 375 px viewport.
- [ ] **2.7** Add `getThinkingSnapshot()` exported helper from
  `lib/realtime/io.ts` so the summary endpoint can return current
  AI:thinking state without a side channel.
- [ ] **2.8** Tests: integration test for `/api/dashboard/summary`
  shape; component test asserting each panel renders given a
  fixture summary.

---

## Sprint 3 — Provider abstraction (Req 14)

> Goal: decouple from DeepSeek so an operator can BYO model.

- [ ] **3.1** Move existing `lib/ai/anthropic.ts` content into
  `lib/ai/providers/deepseek.ts`. Keep
  `lib/ai/anthropic.ts` as a deprecated re-export (logged warning
  on import) for one release.
- [ ] **3.2** Add `lib/ai/providers/index.ts` with the
  `ChatProvider` interface + selector (design §4.1, §4.2).
- [ ] **3.3** Add `lib/ai/providers/anthropic.ts` (real Anthropic
  client). Re-use the existing retry helper logic.
- [ ] **3.4** Add `lib/ai/providers/openai.ts`. Use the existing
  `openai` package already in dependencies.
- [ ] **3.5** Update `lib/ai/runtime.ts` to call
  `getActiveProvider().callWithRetry(req)`. No behaviour change
  expected with the default `AI_PROVIDER=deepseek`.
- [ ] **3.6** Update budget tracker: per-provider pricing
  `<PROVIDER>_INPUT_PRICE_PER_M_USD` /
  `<PROVIDER>_OUTPUT_PRICE_PER_M_USD`. Backfill old envs for
  deepseek as default values. Validates Req 14.4.
- [ ] **3.7** Env-var documentation: `AI_PROVIDER`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, base-url overrides.
- [ ] **3.8** Tests: per-provider adapter tests with a mocked HTTP
  layer (msw). Contract test assert each adapter satisfies the
  four invariants (design §1, Req 14.3).

---

## Sprint 4 — Brand decoupling (Req 16)

> Goal: every visible identifier ships from env, defaults are
> generic. No more old external brand / hard-coded AI name surprises.

- [ ] **4.1** Add env vars: `WORKSPACE_NAME`,
  `AI_AGENT_NAMES_JSON`, `BRAND_COLOR_HEX`. Defaults documented
  in `.env.example`.
- [ ] **4.2** Refactor `prisma/seed.ts` to read from env. Production
  refuses to seed without `WORKSPACE_NAME` set explicitly.
- [ ] **4.3** Move `MENTION_ALIASES` table out of
  `lib/services/message.service.ts`; seed populates each AI's
  `aiSettings.mentionAliases` directly.
- [ ] **4.4** Add `--brand` CSS variable in `app/globals.css`,
  expose via Tailwind config as `theme.colors.brand`.
- [ ] **4.5** Login page header reads from `env.WORKSPACE_NAME`.
- [ ] **4.6** README + LAUNCH_CHECKLIST + any user-facing markdown:
  replace remaining old brand references with the configurable
  workspace name. Audit / spec markdown is the only allowed
  exception.

---

## Sprint 5 — Daily report (Req 15)

> Goal: 18:00 every day, the operator gets a digest in #general
> from each AI. Reason to come back tomorrow.

- [ ] **5.1** Add `lib/reports/daily.ts` with the cron scheduler
  using existing `node-cron`. Idempotent start/stop.
- [ ] **5.2** Add `lib/reports/prompts.ts` with the daily-report
  system instruction. Versioned constant so prompt tweaks are
  diff-reviewable.
- [ ] **5.3** Wire `startDailyReportScheduler()` into `server.ts`
  next to `AgenticLoop.start()`. Add `WORKSPACE_TZ` and
  `DAILY_REPORT_CRON` env vars (default `0 18 * * *` /
  `Asia/Shanghai`).
- [ ] **5.4** `runDailyReportOnce` iterates `User.isAI === true`
  with `aiStatus === 'active'`, calls `runCycle` with a special
  seed message asking for the report. Honor
  `Budget.shouldPauseCycle()` (skip when paused, Audit M1).
- [ ] **5.5** Add `POST /api/reports/trigger` (manual trigger,
  Req 15.6) with rate limit `RateLimits.WRITE` keyed on AI.
- [ ] **5.6** Surface daily reports in the dashboard's "Recent
  activity" panel with distinct styling (filter on
  `metadata.event === 'daily_report'`).
- [ ] **5.7** Tests: scheduler skips when budget paused; manual
  trigger respects rate limit; failure path logs
  `event: 'daily_report_failed'`.

---

## Sprint 6 — Channel membership (Req 17)

> Goal: structured channels. Engineering AI doesn't see marketing
> chatter.

- [ ] **6.1** Add `ChannelMember` model to `prisma/schema.prisma`.
  Generate migration.
- [ ] **6.2** Migration adds the table AND backfills existing
  `(channel, user)` pairs for legacy compatibility.
- [ ] **6.3** Update `MessageService.create` to enforce membership
  with `ValidationError` when the sender isn't in the channel.
- [ ] **6.4** Update `wakeMentionedAIs` to filter AIs by
  `ChannelMember` membership in the originating channel.
- [ ] **6.5** Add `app/api/channels/[channelId]/members/route.ts`:
  GET (list), POST (add), DELETE `?userId=...` (remove). All
  rate-limited via `RateLimits.WRITE` for writes.
- [ ] **6.6** Add UI: channel header gains "Members" affordance;
  dropdown lists current members + an "Add AI" picker. Reuse
  existing dialog primitives.
- [ ] **6.7** Tests: property test that messages from non-members
  always reject; integration test for the membership API.

---

## Sprint 7 — Notifications (Req 18)

> Goal: operator can leave the tab in the background and still
> hear about decisions they need to make.

- [ ] **7.1** Add `lib/notifications/server.ts` with
  `emitNotification(workspaceId, payload)`. Wire into
  `ApprovalService.create`, `TaskService.updateStatus` (Done
  transitions only), and `Budget` breaker trip.
- [ ] **7.2** Extend `ServerToClientEvents` in
  `lib/realtime/events.ts` with `notification:new`. Update Socket
  type bindings.
- [ ] **7.3** Add `app/(workspace)/_components/NotificationProvider.tsx`
  (top-level wrapper). Subscribe to `notification:new`, dedupe by
  tag, fire `new Notification()` if permission granted.
- [ ] **7.4** Permission banner component, dismissal in
  localStorage. First paint only.
- [ ] **7.5** In-app notification panel (Zustand store) — works
  even without browser permission. Click navigates to the linked
  view.
- [ ] **7.6** Tests: throttle (≤ 1 / 60 s per tag); dispatcher
  fires the right `tag` per source.

---

## Sprint 8 — Polish + ship

- [ ] **8.1** Update `.kiro/steering/conventions.md` §10 (helpers
  registry) with all new modules added in sprints 1–7.
- [ ] **8.2** Update `LAUNCH_CHECKLIST.md` deployment env-var table
  with all phase-1 vars.
- [ ] **8.3** Update `README.md` quick-start to mention provider
  selection and dashboard.
- [ ] **8.4** Production rollout checklist:
  - Confirm `RAILWAY_TOKEN` set (or workflow gracefully skips per
    PR #11).
  - Set `WORKSPACE_NAME`, `AI_AGENT_NAMES_JSON`,
    `SEED_HUMAN_PASSWORD`.
  - Either set `TAVILY_API_KEY` or unset `web_search` in
    affected AIs' `aiSettings.toolSet`.
  - Set `WORKSPACE_TZ` to your real time zone.
- [ ] **8.5** Demo video: 60-second walkthrough showing dashboard
  → real `web_search` call → daily report arriving in #general.
- [ ] **8.6** Open Product Hunt draft (don't publish yet — wait
  for Sprint-8 review).

---

## Out of scope (deferred to Phase 2+)

- GitHub deep integration (PR creation, code review by AI). Phase 2.
- Multi-workspace / SaaS billing. Phase 3.
- AI long-term memory / pgvector. Phase 3.
- Visual workflow editor. Phase 4.
- AI configuration marketplace. Phase 4.

These are tracked in `PROJECT_BLUEPRINT.md` for context but
intentionally NOT carried into this spec.
