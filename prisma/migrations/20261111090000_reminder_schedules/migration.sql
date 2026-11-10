-- ─────────────────────────────────────────
--  SCHEDULED REMINDERS (reminder-schedule module). Additive only: one
--  enum, one new table, nothing existing altered or backfilled. Nothing is
--  scheduled by this migration.
-- ─────────────────────────────────────────

-- CreateEnum
CREATE TYPE "ReminderScheduleStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'SKIPPED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ReminderSchedule" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "ReminderScheduleStatus" NOT NULL DEFAULT 'SCHEDULED',
    "sendAt" TIMESTAMP(3) NOT NULL,
    "preset" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "emailSendId" TEXT,
    "queuedCount" INTEGER,
    "skippedRecentlyReminded" INTEGER,
    "skippedOther" INTEGER,
    "skipReason" TEXT,
    "skipMessage" TEXT,

    CONSTRAINT "ReminderSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReminderSchedule_emailSendId_key" ON "ReminderSchedule"("emailSendId");

-- CreateIndex
CREATE INDEX "ReminderSchedule_status_sendAt_idx" ON "ReminderSchedule"("status", "sendAt");

-- CreateIndex
CREATE INDEX "ReminderSchedule_eventId_createdAt_idx" ON "ReminderSchedule"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReminderSchedule" ADD CONSTRAINT "ReminderSchedule_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderSchedule" ADD CONSTRAINT "ReminderSchedule_emailSendId_fkey" FOREIGN KEY ("emailSendId") REFERENCES "EmailSend"("id") ON DELETE SET NULL ON UPDATE CASCADE;
