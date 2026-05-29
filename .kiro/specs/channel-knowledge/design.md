# Design — Channel Knowledge Cards

> Architecture for Requirement 19 (see `requirements.md`). References:
> - `.kiro/specs/ai-native-team-workspace/design.md` (runtime, Property 11/12)
> - `.kiro/specs/phase-1-solo-os/design.md` (channel membership, runCycle options)
> - `.kiro/steering/conventions.md`

## 1. Data model

```prisma
model Channel {
  // ...existing fields...
  knowledge String? @db.Text   // NEW — free-form Markdown card
}
```

- Nullable, no default. Existing rows migrate to `NULL`.
- No backfill: `NULL` == "no card" semantically, so nothing to seed.
- The migration is a pure `ALTER TABLE ADD COLUMN` — zero data risk,
  unlike the ChannelMember migration which needed a backfill.

Migration authored by hand (consistent with prior migrations) as
`prisma/migrations/<ts>_add_channel_knowledge/migration.sql`:

```sql
ALTER TABLE "Channel" ADD COLUMN "knowledge" TEXT;
```

## 2. Service layer

Add to `lib/services/channel.service.ts`:

```ts
const KNOWLEDGE_MAX_LENGTH = 8000;

export async function getKnowledge(channelId: string): Promise<string | null>;
export async function setKnowledge(channelId: string, content: string): Promise<void>;
```

- `getKnowledge` reads `Channel.knowledge` for a channel already
  confirmed in-workspace by the caller.
- `setKnowledge` validates length (throws `ValidationError` over the
  cap — reuse the message service's error class shape or a local one)
  and writes via `prisma.channel.update`.
- A new `getKnowledgeForChannels(channelIds): Promise<Array<{ name; knowledge }>>`
  batch read used by the runtime so injecting N channels' cards is a
  single query.

## 3. API routes

`app/api/channels/[channelId]/knowledge/route.ts`:

- `GET` → `{ content: string | null }`.
  - requireSession; assert channel in workspace (reuse the
    `assertChannelInWorkspace` pattern from the members route); 404
    otherwise.
- `PUT` → body `{ content: string }`, returns `{ content }`.
  - requireSession + `enforceRateLimit('channel-knowledge.write', userId, RateLimits.WRITE)`.
  - Zod: `content: z.string().max(8000)`. Empty string allowed (clears).
  - workspace boundary; 404 / 400 / 500 per the canonical envelope.

Both `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.

## 4. Runtime injection (the important part)

### 4.1 Why the user context, not the system prompt

`runCycle` keeps Property 11: every call carries
`system === SYSTEM_PROMPTS[role]` (or the custom/generic prompt). The
knowledge is *situational data*, not role identity, so it belongs with
the recent-activity digest in `buildInitialContext`, reusing the same
seam the daily-report `extraInstruction` uses.

### 4.2 Which channels

The AI reads the knowledge of every channel it is a **member** of
(Phase 1 Req 17). This:
- leverages the ChannelMember table already in place,
- matches intuition ("the AI understands the projects it participates
  in"),
- avoids threading a single "triggering channelId" through the wakeup
  path, which the current runtime does not carry.

Implementation: in `buildInitialContext(workspaceId, aiUserId, extraInstruction?)`
add the `aiUserId` parameter (already available at the `runCycle` call
site), query:

```ts
const memberChannels = await prisma.channel.findMany({
  where: { workspaceId, members: { some: { userId: aiUserId } }, knowledge: { not: null } },
  select: { name: true, knowledge: true },
});
```

### 4.3 Bounding

- Per-card cap is enforced at write time (8,000).
- Injection assembles cards in channel-name order, accumulating until
  a 12,000-char total budget is reached; further cards are dropped
  with a `(…more channel cards omitted)` marker.
- The assembled block is prepended to the digest content string, so it
  flows through `trimContextToTokenBudget` like everything else. Even
  if a card slips past the char budget, the token trimmer is the final
  backstop.

### 4.4 Shape of the injected block

```
## 频道知识
### #engineering
<knowledge markdown>

### #general
<knowledge markdown>

---
Recent channel digest:
...
```

### 4.5 "已读取频道知识" signal (19.12)

`runCycle` can include a boolean `injectedKnowledge` in its
`RunCycleResult` and structured log. Surfacing it per-message in the UI
requires correlating a cycle with the message it produced, which the
current data model does not directly support (messages don't store the
cycle id). Options:
- MVP: skip the per-message badge; log `injectedKnowledge` for
  observability. (Recommended — keeps scope tight.)
- Follow-up: stamp `message.metadata.injectedKnowledge = true` when an
  AI sends via `send_channel_message` during a knowledge-injected
  cycle, and render the badge from metadata.

This design ships the MVP option and notes the follow-up.

## 5. UI

`components/channel/ChannelKnowledgeCard.tsx` (client):
- Collapsible region rendered at the top of `ChannelView`.
- Collapsed: one-line summary (first non-empty line of the card, or
  "添加频道知识" when empty).
- Expanded: Markdown `<textarea>` + char counter + Save / Cancel.
- Save → `PUT /api/channels/[id]/knowledge`; optimistic update with
  revert on failure.
- Read-only render uses plain `<pre>`/whitespace for the MVP (no
  Markdown renderer dependency); a real renderer is a follow-up.

`ChannelView` fetches the initial card via the GET endpoint (or via a
server-component prop if the channel page is server-rendered) and
passes it to the card component.

## 6. Testing

| Requirement | Test |
|---|---|
| 19.2 / 19.4 | `setKnowledge` rejects > 8,000 chars; accepts empty string. |
| 19.3 / 19.5 | GET/PUT workspace-boundary 404; PUT 400 on non-string / oversize. |
| 19.6–19.8 | runtime injection: non-empty member-channel cards folded into the initial context; NULL/empty skipped; total bounded with the omitted-marker. |

Service + runtime tests mock Prisma per the existing patterns. The
injection test asserts the assembled context string contains the card
text under the `## 频道知识` heading and that an over-budget set emits
the omission marker.

## 7. Rollout

Pure additive + a null-column migration → low risk. No feature flag
needed (an absent card injects nothing, so behaviour is unchanged
until an operator writes a card). Ships in one PR.
