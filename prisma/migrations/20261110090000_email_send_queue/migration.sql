-- ─────────────────────────────────────────
--  EMAIL SEND QUEUE — invitations and reminders sent in the background
--  (email-send module). Additive only: one enum, two new tables, nothing
--  existing altered or backfilled. Nothing is queued by this migration.
--
--  "EmailSendItem_pending_invite_kind_key" is a partial unique index (SQL
--  only, like "Guest_eventId_email_live_key"): at most one QUEUED or
--  SENDING email per invite and kind, so the same guest can't be queued
--  the same email twice while one is waiting or going out.
-- ─────────────────────────────────────────

-- CreateEnum
CREATE TYPE "EmailSendItemStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "EmailSend" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "EventEmailKind" NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSendItem" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "EventEmailKind" NOT NULL,
    "inviteId" TEXT NOT NULL,
    "status" "EmailSendItemStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "previousRemindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSendItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailSend_eventId_createdAt_idx" ON "EmailSend"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailSendItem_status_nextAttemptAt_idx" ON "EmailSendItem"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailSendItem_sendId_status_idx" ON "EmailSendItem"("sendId", "status");

-- CreateIndex
CREATE INDEX "EmailSendItem_inviteId_kind_sentAt_idx" ON "EmailSendItem"("inviteId", "kind", "sentAt");

-- One waiting or in-flight email per invite and kind.
CREATE UNIQUE INDEX "EmailSendItem_pending_invite_kind_key"
    ON "EmailSendItem"("inviteId", "kind")
    WHERE "status" IN ('QUEUED', 'SENDING');

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSendItem" ADD CONSTRAINT "EmailSendItem_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "EmailSend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSendItem" ADD CONSTRAINT "EmailSendItem_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
