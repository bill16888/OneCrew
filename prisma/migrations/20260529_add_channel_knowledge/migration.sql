-- Channel Knowledge Cards (Req 19).
--
-- Pure additive nullable column: NULL means "no card". No backfill
-- needed — existing channels simply have no knowledge until an
-- operator writes one. Zero data-loss risk.

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN "knowledge" TEXT;
