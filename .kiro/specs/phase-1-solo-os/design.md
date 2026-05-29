# Design — Phase 1: Solo Operator OS

> Architecture and contract decisions for Phase 1. References:
> - Parent spec: `.kiro/specs/ai-native-team-workspace/design.md`
> - Project conventions: `.kiro/steering/conventions.md`
> - Phase 1 requirements: `requirements.md` (this directory)

## 1. Module additions

```
lib/
  ai/
    providers/                  ← NEW (Req 14)
      index.ts                  ← provider abstraction + selector
      deepseek.ts               ← extracted from anthropic.ts
      anthropic.ts              ← real Anthropic client
      openai.ts                 ← OpenAI Chat Completions
    tools/
      index.ts                  ← extended TOOL_DEFINITIONS to 8
      mocks.ts                  ← unchanged (Property 14)
      web-search.ts             ← NEW (Req 12)
      project-docs.ts           ← NEW (Req 12)
  reports/
    daily.ts                    ← NEW (Req 15) — scheduler + cycle harness
    prompts.ts                  ← NEW — daily-report system instruction
  notifications/
    server.ts                   ← NEW (Req 18) — emit `notification:new` events
app/
  (workspace)/
    dashboard/
      page.tsx                  ← NEW (Req 13)
      _components/              ← panel components
        TodayPulse.tsx
        AIStatusGrid.tsx
        PendingApprovalsList.tsx
        RecentActivityTimeline.tsx
  api/
    dashboard/
      summary/route.ts          ← NEW (Req 13) — single endpoint for all 4 panels
    reports/
      trigger/route.ts          ← NEW (Req 15.6) — manual daily report
    channels/
      [channelId]/
        members/route.ts        ← NEW (Req 17) — list / add / remove members
prisma/
  schema.prisma                 ← extend with ChannelMember
```

## 2. Real-tool design (Req 12)

### 2.1 Why not extend the mock helpers

The mock helpers in `lib/ai/tools/mocks.ts` carry an explicit
purity invariant (Property 14) that's spec-locked AND
property-tested. Reusing them as the real implementation would
break that contract. We add **new** tool entries instead and let
the dispatcher route by name.

### 2.2 `web_search` — provider selection

Two providers fit the Phase 1 budget (≤ $1 / 1k searches):

- **Tavily** (`https://api.tavily.com`) — purpose-built for AI
  agents, returns ranked results with snippets, supports
  `search_depth: "basic"|"advanced"`. Default.
- **Serper** (`https://google.serper.dev`) — Google SERP wrapper,
  cheaper but more verbose response shape.

Selection via `WEB_SEARCH_PROVIDER=tavily|serper`. Both providers'
adapters live in `lib/ai/tools/web-search.ts` and expose a single
`webSearch(query, options): Promise<SearchResult[]>` function.
Adapters are isolated so swapping or adding providers doesn't ripple
into the dispatcher.

### 2.3 `read_project_docs` — GitHub Contents API

Endpoint: `GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}`

Auth strategy:

1. If `GITHUB_TOKEN` env var is set → use it (PAT or Actions token).
2. Else → unauthenticated (60 req/h shared rate limit).

Response handling:

- 200 with `type === 'file'` → base64-decode `content`, return UTF-8
  body capped at 64 KB.
- 200 with `type === 'dir'` → render a markdown list of entries
  + their types so the AI can refine its next call.
- 404 / 403 → return `tool_result { is_error: true }` with a
  user-readable message; do NOT throw.

### 2.4 Failure handling (Req 12.4)

Both real tools share a `withSafeExecution(toolName, fn)` helper:

```ts
async function withSafeExecution<T>(
  toolName: string,
  fn: () => Promise<T>,
  formatter: (result: T) => string,
): Promise<{ ok: true; content: string } | { ok: false; content: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const result = await fn();
    clearTimeout(timeout);
    return { ok: true, content: formatter(result) };
  } catch (err) {
    logger.warn(
      { event: `${toolName}_failed`, err: err instanceof Error ? err.message : err },
      `${toolName} failed`,
    );
    return {
      ok: false,
      content: `${toolName} unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
```

The dispatcher at the call site converts `ok: false` to
`tool_result { is_error: true, content }`.

### 2.5 Budget integration (Req 12.6)

`web_search` calls `Budget.trackOther(0.001, 'web_search')` after
a successful response. Add a new `trackOther(usd, source)` method to
`Budget` that records non-token-based costs. The MVP's existing
`track(usage, model)` is unchanged. `read_project_docs` does not
charge.

## 3. Dashboard design (Req 13)

### 3.1 Single summary endpoint

To stay under the 2 s P99 budget we collapse the four panels'
backend work into ONE endpoint:

```
GET /api/dashboard/summary
→ {
    pulse: { messages: { total, ai }, tasksCompleted, approvalsDecided },
    ai: Array<{ id, name, aiStatus, lastFinishReason, isThinking, channels: string[] }>,
    pendingApprovals: Approval[],
    recentActivity: Array<{ kind, ... }>,
  }
```

Implementation: a single Prisma `$transaction` doing four reads in
parallel, plus a snapshot of the in-memory `ai:thinking` state from
`lib/realtime/io.ts` (new exported helper `getThinkingSnapshot()`).

### 3.2 Realtime updates

The dashboard subscribes to:

- `workspace:{id}` — for `ai:thinking` and `approval:created`
- All channels the operator is a member of — for `message:new`
  / `task:updated`

Subscription happens via the existing `subscribeToChannel` helper.
On unmount we call `unsubscribeFromChannel` for each (Audit L2).

Updates patch the cached summary in Zustand instead of refetching.

### 3.3 Mobile fallback

Tailwind: `grid-cols-1 lg:grid-cols-2 xl:grid-cols-4`. Below
1024 px the four panels stack; we tested this approach in the
existing kanban code.

## 4. Provider abstraction (Req 14)

### 4.1 Common interface

```ts
// lib/ai/providers/index.ts
export interface ChatProvider {
  readonly name: 'deepseek' | 'anthropic' | 'openai';
  readonly defaultModel: string;
  callWithRetry(req: ChatRequest): Promise<ChatResponse>;
  estimateCost(usage: Usage, model: string): number;
}
```

`ChatRequest` and `ChatResponse` are the existing Anthropic-like
shapes used by `lib/ai/runtime.ts`. Adapters convert to/from each
provider's native format.

### 4.2 Selector

```ts
// lib/ai/providers/index.ts
export function getActiveProvider(): ChatProvider {
  const name = env.AI_PROVIDER;
  switch (name) {
    case 'anthropic': return anthropicProvider;
    case 'openai':    return openaiProvider;
    case 'deepseek':
    default:          return deepseekProvider;
  }
}
```

`runtime.ts` calls `getActiveProvider().callWithRetry(req)`
instead of the current `callAnthropicWithRetry` import. The
existing OpenAI-bridge translation lives inside the deepseek and
openai adapters.

### 4.3 Migration path

Phase 1 ships all three adapters but `AI_PROVIDER=deepseek` stays
the default so existing deployments don't change behaviour.
`anthropic.ts` extracts the existing retry / token-budget logic;
the file moves but its public interface is preserved during the
deprecation window. After two releases without complaints the
old import path is removed.

## 5. Daily report (Req 15)

### 5.1 Scheduler

`node-cron` is already a dep (used by `scripts/backup-cron.ts`).
We reuse it:

```ts
// lib/reports/daily.ts
import cron from 'node-cron';

export function startDailyReportScheduler(): { stop: () => void } {
  const expr = env.DAILY_REPORT_CRON;
  const tz = env.WORKSPACE_TZ;
  const task = cron.schedule(expr, runDailyReportOnce, { timezone: tz });
  task.start();
  return { stop: () => task.stop() };
}
```

`server.ts` adds a `startDailyReportScheduler()` call alongside
the existing `AgenticLoop.start()`.

### 5.2 Per-AI cycle

For each active AI, we synthesize a special user message and
invoke `runCycle` with that as the seed instead of the current
"recent channel digest". The seed asks for a structured report and
ends with: "When you're done, call send_channel_message to
#general with your report."

The runtime's `MAX_ROUNDS = 5` is enough — daily reports rarely
exceed 2 rounds.

### 5.3 Manual trigger (Req 15.6)

`POST /api/reports/trigger { aiUserId }` runs the same code path
as the scheduler but for a single AI. Per-AI rate limit:
`RateLimits.WRITE` keyed on `daily-report:${aiUserId}`.

## 6. Brand decoupling (Req 16)

### 6.1 Env-driven seed

Replace the hard-coded constants in `prisma/seed.ts`:

```ts
const WORKSPACE_NAME = env.WORKSPACE_NAME ?? 'My Workspace';
const AI_AGENTS = JSON.parse(env.AI_AGENT_NAMES_JSON ?? DEFAULT_JSON);
```

`DEFAULT_JSON` is `[{"name":"Architect","role":"engineer", ...},
{"name":"Coordinator","role":"pm", ...}]`. Production refuses to
seed without explicit env vars (matches `SEED_HUMAN_PASSWORD`
discipline from Audit M5).

### 6.2 Mention aliases

Move `MENTION_ALIASES` from `lib/services/message.service.ts` to
the seed payload — each AI's `aiSettings.mentionAliases` is set
once at seed time. The runtime side already prefers per-AI
aliases (Audit H1).

### 6.3 Tailwind brand variable

Add to `app/globals.css`:

```css
:root {
  --brand: #6366f1; /* configurable via env at build time */
}
```

`tailwind.config.ts` exposes this as `theme.colors.brand`. UI
components stop importing `@/lib/brand-colors` (delete that file
if present).

## 7. Channel membership (Req 17)

### 7.1 Schema

```prisma
model ChannelMember {
  channelId String
  userId    String
  role      String   @default("human") // 'human' | 'ai'
  joinedAt  DateTime @default(now())

  channel Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([channelId, userId])
  @@index([userId])
}
```

Migration also adds a backfill step that populates `ChannelMember`
for every existing `(channel, user)` pair.

### 7.2 Service-layer enforcement

`MessageService.create` adds:

```ts
const isMember = await prisma.channelMember.findUnique({
  where: { channelId_userId: { channelId, userId } },
});
if (!isMember) {
  throw new ValidationError('Sender is not a member of this channel.');
}
```

`wakeMentionedAIs` filters the AI lookup by membership via
`prisma.channelMember.findMany({ where: { channelId, role: 'ai' } })`.

## 8. Notifications (Req 18)

### 8.1 Server-side: realtime event

`lib/notifications/server.ts` exposes a single function:

```ts
export function emitNotification(
  workspaceId: string,
  payload: NotificationPayload,
): void;
```

It uses the existing `getIO()` and broadcasts a `notification:new`
event scoped to `workspace:{id}`. Service layers that fire it:

- `ApprovalService.create` after the existing `approval:created` emit
- `TaskService.updateStatus` when transitioning to `Done`
- `lib/ai/budget.ts` when the breaker trips

### 8.2 Client-side handler

A new top-level provider in `app/(workspace)/layout.tsx` registers
`socket.on('notification:new', handleNotification)`. The handler:

1. Throttles by `payload.tag` (≤ 1 / 60 s).
2. Calls `new Notification(title, { tag, body, icon })` if
   permission was granted.
3. Mirrors the notification into a Zustand-backed in-app
   notification panel so users without permission still see them.

### 8.3 Permission UX

A first-paint banner asks for permission once. Dismissal is keyed
in `localStorage` under `notifications.dismissed=<userId>`.

## 9. Test strategy

| Requirement | New tests |
|---|---|
| Req 12 | Property test: malformed provider response always resolves to `is_error: true`. Unit tests for the GitHub size cap, dir-vs-file branching. |
| Req 13 | Integration test: `/api/dashboard/summary` returns the expected shape and respects `RateLimits.READ_HEAVY`. |
| Req 14 | Per-provider adapter tests with a mocked HTTP layer (msw). One contract test asserts every adapter satisfies the `ChatProvider` interface and the four invariants. |
| Req 15 | Test that the scheduler runs at the right time (using node-cron's mock clock) and skips when budget is paused. |
| Req 16 | Snapshot test of seeded workspace name / AI names from env. |
| Req 17 | Property test: messages from non-members reject with `ValidationError`. |
| Req 18 | Throttle test using fake timers (≤ 1 fire per tag per 60 s). |

Total new test count target: ~30 (on top of the existing 121).

## 10. Migration / rollout

Each phase-1 PR follows the steering convention §2 (requireSession +
enforceRateLimit + Zod) and §11 PR checklist. Rollout sequence:

1. Req 14 (provider abstraction) — no user-facing change, lowers
   risk for everything that follows.
2. Req 12 (real tools) — opt-in via env flags, mocks remain.
3. Req 16 (brand) — no behaviour change, only configurability.
4. Req 13 (dashboard) — additive; old routes still work.
5. Req 15 (daily report) — opt-in via `DAILY_REPORTS_ENABLED=true`
   for safe rollout.
6. Req 17 (channel membership) — schema migration with backfill.
7. Req 18 (notifications) — additive UI feature.
