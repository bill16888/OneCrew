-- Add configurable AI-colleague settings and lifecycle status.
ALTER TABLE "User"
  ADD COLUMN "aiSettings" JSONB,
  ADD COLUMN "aiStatus" TEXT DEFAULT 'active';

CREATE INDEX "User_isAI_aiStatus_idx" ON "User"("isAI", "aiStatus");
