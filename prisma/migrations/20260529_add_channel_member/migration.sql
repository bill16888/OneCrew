-- Phase 1 Req 17: channel membership.
--
-- Adds the ChannelMember join table and BACKFILLS every existing
-- (channel, user) pair within the same workspace so legacy behaviour
-- (every workspace user is in every channel) is preserved. Without the
-- backfill, MessageService.create's new membership check would reject
-- all existing senders the moment this migration lands.

-- CreateTable
CREATE TABLE "ChannelMember" (
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'human',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMember_pkey" PRIMARY KEY ("channelId","userId")
);

-- CreateIndex
CREATE INDEX "ChannelMember_userId_idx" ON "ChannelMember"("userId");

-- AddForeignKey
ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: grandfather every workspace user into every channel of the
-- same workspace. role mirrors User.isAI so the membership rows carry
-- the same human/ai distinction the API uses going forward.
INSERT INTO "ChannelMember" ("channelId", "userId", "role", "joinedAt")
SELECT c."id", u."id",
       CASE WHEN u."isAI" THEN 'ai' ELSE 'human' END,
       CURRENT_TIMESTAMP
FROM "Channel" c
JOIN "User" u ON u."workspaceId" = c."workspaceId"
ON CONFLICT ("channelId", "userId") DO NOTHING;
