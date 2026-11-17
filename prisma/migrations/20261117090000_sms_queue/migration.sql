-- ─────────────────────────────────────────
--  SMS THROUGH THE SEND QUEUE (SMSPortal) — additive only: one enum, new
--  nullable or defaulted columns, two indexes. Nothing existing altered or
--  backfilled; every existing EmailSendItem is an email (channel's default)
--  and every existing SmsSendLog row was one part (parts' default).
-- ─────────────────────────────────────────

-- CreateEnum
CREATE TYPE "SmsDeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "EmailSendItem"
    ADD COLUMN "channel" "DeliveryMethod" NOT NULL DEFAULT 'EMAIL',
    ADD COLUMN "smsSource" "SmsSendSource",
    ADD COLUMN "providerCallAt" TIMESTAMP(3),
    ADD COLUMN "providerMessageId" TEXT,
    ADD COLUMN "smsParts" INTEGER,
    ADD COLUMN "deliveryStatus" "SmsDeliveryStatus",
    ADD COLUMN "deliveryStatusAt" TIMESTAMP(3),
    ADD COLUMN "deliveryError" TEXT;

-- AlterTable
ALTER TABLE "Invite"
    ADD COLUMN "smsStatus" "SmsDeliveryStatus",
    ADD COLUMN "smsStatusAt" TIMESTAMP(3),
    ADD COLUMN "smsStatusReason" TEXT;

-- AlterTable
ALTER TABLE "SmsSendLog"
    ADD COLUMN "parts" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "emailSendItemId" TEXT;

-- CreateIndex
CREATE INDEX "EmailSendItem_providerMessageId_idx" ON "EmailSendItem"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "SmsSendLog_emailSendItemId_key" ON "SmsSendLog"("emailSendItemId");
