-- Storage rules, Round B (STEERING "Storage"; src/modules/storage-retention/).
-- Additive only: new columns, two new tables, and backfills of the new
-- columns. Nothing is deleted by this migration, and nothing is deleted on
-- the first sweep after it:
--
-- - MemoryItem.rejectedAt / removedAt: when the organiser rejected or
--   removed (archived) an item; 7 days later its file is deleted. Every
--   item already rejected, or already removed, and not purged gets the
--   time this migration runs (UTC), so its 7 days start at deploy.
-- - Event.cancelledAt: when it was cancelled; its guests' documents are
--   deleted 30 days later. Every event already cancelled gets the time this
--   migration runs, so its 30 days start at deploy.
-- - SubscriptionTierConfig.maxDocumentBytesPerEvent / maxDocumentBytesPerFile:
--   guests' documents' own allowance (no longer counted in the Memory
--   Hub's). Set per tier below: null would be unlimited (fails open).
-- - EventDocumentPurge / DocumentPurgeReminderClaim: one claim per event and
--   rule, for the deletion and for the organisers' reminder.

-- CreateEnum
CREATE TYPE "DocumentRetentionReason" AS ENUM ('ARCHIVED_AT_FINISH', 'FINISHED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MemoryItem" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "removedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SubscriptionTierConfig" ADD COLUMN     "maxDocumentBytesPerEvent" BIGINT,
ADD COLUMN     "maxDocumentBytesPerFile" INTEGER;

-- CreateTable
CREATE TABLE "EventDocumentPurge" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "reason" "DocumentRetentionReason" NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EventDocumentPurge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPurgeReminderClaim" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "reason" "DocumentRetentionReason" NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentPurgeReminderClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventDocumentPurge_eventId_reason_key" ON "EventDocumentPurge"("eventId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPurgeReminderClaim_eventId_reason_key" ON "DocumentPurgeReminderClaim"("eventId", "reason");

-- CreateIndex
CREATE INDEX "MemoryItem_rejectedAt_idx" ON "MemoryItem"("rejectedAt");

-- CreateIndex
CREATE INDEX "MemoryItem_removedAt_idx" ON "MemoryItem"("removedAt");

-- AddForeignKey
ALTER TABLE "EventDocumentPurge" ADD CONSTRAINT "EventDocumentPurge_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPurgeReminderClaim" ADD CONSTRAINT "DocumentPurgeReminderClaim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: rejected and removed items, and cancelled events, start their
-- clocks now, never earlier.
UPDATE "MemoryItem" SET "rejectedAt" = (now() AT TIME ZONE 'UTC') WHERE "status" = 'REJECTED' AND "purgedAt" IS NULL AND "rejectedAt" IS NULL;
UPDATE "MemoryItem" SET "removedAt" = (now() AT TIME ZONE 'UTC') WHERE "isArchived" = true AND "purgedAt" IS NULL AND "removedAt" IS NULL;
UPDATE "Event" SET "cancelledAt" = (now() AT TIME ZONE 'UTC') WHERE "status" = 'CANCELLED' AND "cancelledAt" IS NULL;

-- The document allowance, per tier (STEERING "Tier enforcement": a new
-- limit column needs a per-tier UPDATE). 500 MB per event, 5 MB per
-- document, on every tier: the free plan's figures, and 5 MB is what every
-- document was held to before.
UPDATE "SubscriptionTierConfig" SET "maxDocumentBytesPerEvent" = 524288000, "maxDocumentBytesPerFile" = 5242880 WHERE "tier" = 'SPARK';
UPDATE "SubscriptionTierConfig" SET "maxDocumentBytesPerEvent" = 524288000, "maxDocumentBytesPerFile" = 5242880 WHERE "tier" = 'CELEBRATE';
UPDATE "SubscriptionTierConfig" SET "maxDocumentBytesPerEvent" = 524288000, "maxDocumentBytesPerFile" = 5242880 WHERE "tier" = 'ELEVATE';
