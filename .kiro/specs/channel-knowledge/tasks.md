# Tasks — Channel Knowledge Cards

> Implementation plan for Requirement 19. Follow
> `.kiro/steering/conventions.md`. Single-PR scope.

## 1. Data + migration

- [ ] 1.1 Add `knowledge String? @db.Text` to `Channel` in
  `prisma/schema.prisma`; regenerate client.
- [ ] 1.2 Hand-author `prisma/migrations/<ts>_add_channel_knowledge/migration.sql`
  with `ALTER TABLE "Channel" ADD COLUMN "knowledge" TEXT;` (no
  backfill — NULL means "no card").

## 2. Service layer

- [ ] 2.1 `lib/services/channel.service.ts`: add `KNOWLEDGE_MAX_LENGTH = 8000`,
  `getKnowledge(channelId)`, `setKnowledge(channelId, content)` (throws
  on > cap), and `getKnowledgeForChannels(workspaceId, aiUserId)` batch
  read (member channels, non-null knowledge).
- [ ] 2.2 Export the new fns on the `ChannelService` namespace object.

## 3. API

- [ ] 3.1 `app/api/channels/[channelId]/knowledge/route.ts`:
  - GET → `{ content }`, requireSession + workspace 404.
  - PUT → `{ content }`, requireSession + `RateLimits.WRITE` + Zod
    (`content: z.string().max(8000)`) + workspace 404.

## 4. Runtime injection

- [ ] 4.1 `lib/ai/runtime.ts`: extend `buildInitialContext` to accept
  `aiUserId`, query member channels' knowledge via
  `ChannelService.getKnowledgeForChannels`, assemble the `## 频道知识`
  block (channel-name order, 12,000-char total budget, omission
  marker), prepend to the digest content.
- [ ] 4.2 Thread `aiUserId` from `runCycle` into `buildInitialContext`
  (already in scope at the call site).
- [ ] 4.3 Add `injectedKnowledge: boolean` to `RunCycleResult` + the
  cycle-finished log line (observability for 19.12; per-message badge
  deferred).

## 5. UI

- [ ] 5.1 `components/channel/ChannelKnowledgeCard.tsx`: collapsible
  card, Markdown textarea, char counter, Save/Cancel → PUT.
- [ ] 5.2 Mount it at the top of `ChannelView`; fetch initial content
  via GET (or server prop).

## 6. Tests

- [ ] 6.1 `setKnowledge` cap + empty-string behaviour.
- [ ] 6.2 Knowledge API workspace-boundary 404 + PUT 400 oversize.
- [ ] 6.3 Runtime injection: member-channel non-empty cards folded
  under `## 频道知识`; NULL/empty skipped; over-budget set emits the
  omission marker.

## 7. Docs

- [ ] 7.1 No new env vars. Note the feature in README quick-start if
  appropriate (optional).

## Deferred (follow-up)

- Per-message "已读取频道知识" badge (needs message↔cycle correlation
  via `message.metadata`).
- Markdown rendering in the read-only card view (MVP uses plain text).
- Per-channel injection (vs per-membership) if a future need arises.
