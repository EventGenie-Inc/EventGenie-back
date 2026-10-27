-- Archived events: Memory Hub photos and videos deleted after 30 days
-- (src/modules/media-retention/).
--
-- Event.archivedAt records when an event was archived (null while live);
-- 30 days later the sweep deletes its Memory Hub media from Cloudinary and
-- marks each MemoryItem purged (purgedAt, and archived). EventMediaPurge is
-- one purge per event and archiving; MediaPurgeReminderClaim is the
-- append-only claim of the reminder email sent 7 days before.
--
-- Data: every event already archived gets archivedAt = the time this
-- migration runs (in UTC, like every other timestamp column), never an
-- older guess, so its 30 days start at deploy and nothing is purged on the
-- first sweep. Live events keep null.

-- CreateEnum
CREATE TYPE "EventMediaPurgeReason" AS ENUM ('RETENTION', 'SUPER_ADMIN');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MemoryItem" ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EventMediaPurge" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL,
    "reason" "EventMediaPurgeReason" NOT NULL,
    "requestedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "purgedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "EventMediaPurge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaPurgeReminderClaim" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaPurgeReminderClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventMediaPurge_completedAt_idx" ON "EventMediaPurge"("completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventMediaPurge_eventId_archivedAt_key" ON "EventMediaPurge"("eventId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaPurgeReminderClaim_eventId_archivedAt_key" ON "MediaPurgeReminderClaim"("eventId", "archivedAt");

-- AddForeignKey
ALTER TABLE "EventMediaPurge" ADD CONSTRAINT "EventMediaPurge_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaPurgeReminderClaim" ADD CONSTRAINT "MediaPurgeReminderClaim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: events archived before this release start their 30 days now.
UPDATE "Event" SET "archivedAt" = (now() AT TIME ZONE 'UTC') WHERE "isArchived" = true AND "archivedAt" IS NULL;
