# Project Conventions — yubiao-workspace

Project-wide rules distilled from the 2026-05 audit (PRs #1–#4). New
code MUST follow these unless a comment explicitly justifies the
deviation. Existing exceptions are individually called out.

References to the original product spec:
- `#[[file:.kiro/specs/ai-native-team-workspace/requirements.md]]`
- `#[[file:.kiro/specs/ai-native-team-workspace/design.md]]`

---

## 1. Layered architecture

```
app/api/**/route.ts   → app/(workspace)/**/page.tsx
        │                       │
        ▼                       ▼
       lib/services/*.service.ts        ← single source of truth for
        │                                 domain rules + realtime
        ▼                                 broadcasts
       lib/prisma.ts (Prisma client)
```

Hard rules:
- **Routes never call Prisma directly** for write paths. Routes
  validate input and delegate to a service. Read-only listing routes
  may call Prisma if no domain logic applies (`/api/ai-colleagues`
  GET is the existing exception — listing only).
- **Services own realtime broadcasts**. Emit `message:new` /
  `task:updated` / `approval:created` ONLY after the DB commit
  succeeds. Never broadcast from a route handler.
- **Service errors propagate as either `ValidationError`
  (→ HTTP 400) or raw Prisma errors (→ HTTP 500/404)**. Routes use
  `instanceof ValidationError` to translate; do not invent new error
  classes per service.

## 2. API route checklist

Every new `app/api/**/route.ts` for a write endpoint MUST:

1. Import from `@/lib/api-helpers`:
   ```ts
   import {
     enforceRateLimit,
     errorResponse,
     requireSession,
     type ApiErrorResponse,
   } from '@/lib/api-helpers';
   import { RateLimits } from '@/lib/ratelimit';
   ```
2. Run `requireSession()` first. If it returns a `NextResponse`,
   return it directly. Never use `getServerSession(authOptions)`
   inline.
3. Run `enforceRateLimit(scope, session.user.id, RateLimits.X)`
   second. Pick the bucket family that matches the endpoint:
   - `RateLimits.MESSAGE` for chat
   - `RateLimits.APPROVAL` for approval decisions
   - `RateLimits.WRITE` for everything else
4. Validate the body with Zod (`safeParse`); on failure return
   `errorResponse(formatZodError(err), 400)`.
5. Delegate to a service. Translate `ValidationError → 400`,
   Prisma `P2025 → 404`, anything else → 500.
6. Read-only `GET` endpoints skip the rate-limit step today; they
   may add `RateLimits.READ_HEAVY` later if abuse appears.

The middleware (`middleware.ts`) returns JSON 401 for any
unauthenticated `/api/*` request (audit H3). Page routes still
redirect to `/login`. Never special-case auth inside an API route
handler — the middleware handles it.

## 3. Workspace boundaries (multi-tenant ready)

- Read `resolveWorkspaceId()` from `@/lib/workspace`. Never hardcode
  `'ws_default'`.
- Every service write that targets a row owned by a workspace MUST
  scope by `workspaceId` in the `where` clause. Examples already in
  place: `TaskService.updateStatus`, `ApprovalService.approve`,
  `ApprovalService.reject`, `MessageService.create`.
- The MVP has a single workspace today, so the scoping is currently
  a tautology. Keep it anyway — the multi-workspace migration will
  flip `resolveWorkspaceId` to read from the session and every
  scoped query upgrades for free.

## 4. AI runtime

- All AI-side effects flow through `dispatchTool` in
  `lib/ai/tools/index.ts`. The dispatcher is a **total function**:
  never throws, never reaches outside the 6-tool surface, never
  bypasses the per-AI `toolSet` whitelist read from
  `User.aiSettings.toolSet`.
- Anthropic / DeepSeek calls happen ONLY through
  `callAnthropicWithRetry` in `lib/ai/anthropic.ts`. Bound retries
  to its existing budget (3 retries / 4 attempts).
- Track every model call with `budget.track()`. Honour
  `budget.shouldPauseCycle()` (95% threshold) before starting a
  cycle so we never overshoot the daily ceiling by more than the
  cost of one in-flight cycle.
- Model pricing comes from `AI_INPUT_PRICE_PER_M_USD` and
  `AI_OUTPUT_PRICE_PER_M_USD`. Do NOT hardcode rates.
- User-visible messages from the runtime (e.g. budget-exceeded
  notice) read from env (`AI_BUDGET_EXCEEDED_NOTICE`) so locales
  can be swapped without a redeploy.

## 5. Realtime / Socket.io

- Cookie parsing for the WebSocket handshake lives in
  `@/lib/cookie-parser`. Do not roll a new parser. The chunked
  cookie path is property-tested against insertion-order
  permutations.
- Channel rooms: clients call `subscribeToChannel(id)` on mount and
  `unsubscribeFromChannel(id)` in the `useEffect` cleanup. Never
  rely on the disconnect path alone — long-lived sessions
  accumulate rooms otherwise.
- Default transports are `['websocket', 'polling']`. Operators can
  pin to polling-only via `NEXT_PUBLIC_SOCKET_TRANSPORTS=polling`
  for environments where the proxy strips the `Upgrade` header.

## 6. Logging

- `lib/**` server code uses the shared pino logger from
  `@/lib/logger`. **`console.*` is forbidden** in `lib/**`.
- Allowed `console.*` zones:
  - `components/**` (browser code; pino is server-only)
  - `scripts/**` (CLI / startup wrappers; pino isn't booted yet)
  - `prisma/seed.ts` (CLI)
  - `server.ts` early-lifecycle (before pino is wired)
- Forward unexpected runtime errors to Sentry via
  `Sentry.captureException(err, { tags, extra })`. Mirror the
  payload of the matching `logger.error` call so log lines can be
  pivoted to Sentry events 1:1.
- Mention / wakeup / cycle events log structured records with an
  `event` field. Pick a stable string and reuse it.

## 7. Database / Prisma

- Schema migrations: author with `prisma migrate dev`, deploy with
  `prisma migrate deploy`. The startup wrapper
  (`scripts/railway-start.ts`) auto-handles legacy `db push` DBs
  via P3005 baselining; no manual intervention required.
- **Never reintroduce `prisma db push --accept-data-loss`** in the
  default deploy path. The `PRISMA_DEPLOY_STRATEGY=push` env
  override exists strictly for greenfield first-deploy cases.
- Every FK column gets an explicit `@@index([fk])`.
- Seed scripts read passwords from env
  (`SEED_HUMAN_PASSWORD`); production refuses to fall back to
  `password123`.
- Bcrypt rounds: ≥ 12 (configurable via `SEED_BCRYPT_ROUNDS`).

## 8. Security

- Rate limiter: `@/lib/ratelimit`. In-process token bucket; will
  migrate to Redis when the cluster grows past one Node instance.
  Add a new bucket family in `RateLimits` rather than inlining
  capacity / windowMs at the call site.
- Default security headers (CSP / HSTS / X-Frame / Permissions-
  Policy / etc.) configured in `next.config.mjs`. New external
  origins (e.g. analytics, tracing) must be added to the CSP
  allow-list there.
- Bcrypt for password hashing. Never roll a custom hashing path.
- API responses NEVER leak internal error messages — translate to
  `{ error: '<safe summary>' }`. Detailed context goes to logs +
  Sentry.

## 9. Testing

- Vitest + fast-check for property tests. Playwright for e2e (one
  smoke test today).
- Prisma is mocked at `@/lib/prisma` in service tests. **Whenever
  a service adds a new Prisma method call** (e.g. a new
  `findFirst` for a workspace boundary check), update the
  corresponding test mock in the same PR.
- UI strings are product copy. The component value AND the
  matching contract test (e.g.
  `tests/components/ui-contract.test.ts`) MUST move together.
  Reference: PR #4 (KanbanBoard label drift).
- Pre-existing failures are not acceptable as a long-term state.
  If a PR can fix one in the same area it touches, do so; if not,
  open a tracking issue. Don't ship "1 unrelated fail" indefinitely.

## 10. Where shared helpers live

| Module | Purpose |
|---|---|
| `lib/api-helpers.ts` | `requireSession`, `enforceRateLimit`, `errorResponse`, `ApiErrorResponse` |
| `lib/ratelimit.ts` | In-process token bucket, `RateLimits` defaults |
| `lib/workspace.ts` | `resolveWorkspaceId`, `DEFAULT_WORKSPACE_ID` |
| `lib/cookie-parser.ts` | RFC 6265 cookie / NextAuth chunked-cookie parsing |
| `lib/logger.ts` | Shared pino instance (`logger.info/warn/error`) |
| `lib/env.ts` | Validated env (zod). Read here, not from `process.env` |
| `lib/prisma.ts` | Singleton Prisma client |
| `lib/ai/anthropic.ts` | The only place that calls the model API |
| `lib/ai/tools/index.ts` | The only place that runs AI side effects |

---

## 11. Pull-request checklist

Before opening a PR, confirm:
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npx vitest run` passes (or every new failure is justified
      in the PR description)
- [ ] Any new write endpoint goes through
      `requireSession + enforceRateLimit + Zod`
- [ ] Any new service write that targets a workspace-owned row
      scopes by `workspaceId`
- [ ] `console.*` is absent from `lib/**`
- [ ] If you added a new `lib/**` helper, it is documented in
      §10 above
- [ ] If you changed UI copy that has a contract test, the test
      moves in lockstep



## 12. Stacked PR workflow

When a feature naturally splits into multiple PRs that build on each
other (the 2026-05 audit was 4 stacked PRs: #1 → #2 → #3 → #6), the
**squash-merge replays as new commits on main**, so each downstream
PR's old base hash points at history that no longer exists. GitHub
flags this as "conflicts must be resolved" even when the diffs are
semantically identical.

### Rules

1. **Merge the stack from the bottom up, one PR at a time.**
   Do NOT queue multiple stacked PRs and merge them in a batch. Squash-
   merging the lowest PR rewrites every downstream PR's base.
2. **After merging the lower PR, immediately rebase the next one on
   main** — do not let the stack go stale across multiple merges, that
   compounds the rebase difficulty.
3. **Use `git rebase --onto origin/main <old-base> <branch>`**, not
   `git rebase main`. The `--onto` form moves only the commits that
   the downstream PR actually added; the plain form re-applies every
   ancestor commit and re-creates the conflict.
4. **Force-pushing to a sandbox-managed PR branch may fail with `stale
   info` because the agent cannot fetch the remote ref.** When that
   happens, push the rebased branch under a new name (`<branch>-rebased`
   or `-final`) and open a replacement PR; close the old PR without
   merging.
5. **Standalone PRs that touch files broken on main need their fix
   carried forward.** PR #4 (UI label test) and PR #5 (steering doc)
   each had to cherry-pick the C1 JSX fix from #1 because the test /
   build wouldn't pass on main alone. Lesson: any PR that runs CI
   independently must compile against `main` as it currently is.

### Mechanics for an audit-style cleanup

```bash
# After PR #N (lower) lands on main:
git fetch origin
git checkout fix/audit-stage-N+1

# Find the old base — the squash commit on main that this branch was
# originally rebased onto. `git log` against origin/main usually shows
# it as the last "(#N)" line; copy that hash.
OLD_BASE=<sha of the squash commit you originally branched off>

git rebase --onto origin/main "$OLD_BASE" fix/audit-stage-N+1
# Resolve any conflicts that come from dedup work where the upstream
# PR removed an inline helper that the downstream branch still owned.
# (See PR #7's lib/services/message.service.ts dedup, which left a
# stale local resolveWorkspaceId after the rebase.)

npm run typecheck && npm run lint && npx vitest run

# If the agent push tool reports `stale info`, push to a fresh branch:
git checkout -b fix/audit-stage-N+1-rebased
git push -u origin fix/audit-stage-N+1-rebased
# Open a replacement PR, close the old one without merging.
```

### When to opt out of the stack

If a downstream PR can be split into parts that don't depend on the
upstream change, ship them as independent PRs against main. The
audit's PR #4 and PR #5 were intentionally kept independent for this
reason — they merged in any order. Reserve stacking for cases where
the dependency is real (e.g. test fixtures introduced upstream that
downstream tests need).
