-- Document fields: a guest uploads a file (a proof of payment, say) as the
-- answer to a DOCUMENT question (src/modules/guest-document/).
--
-- Additive only: a new value on RsvpFieldType, a nullable description on
-- RsvpField (help text under any question; null for every existing one),
-- and the GuestDocument table, one row per uploaded file. Nothing existing
-- is renamed, dropped or rewritten, so every saved event, question and
-- answer reads exactly as before.
--
-- ALTER TYPE ... ADD VALUE runs inside the migration's transaction, which
-- Postgres allows (12+) as long as the new value isn't used in the same
-- transaction; nothing here uses it.

-- CreateEnum
CREATE TYPE "GuestDocumentSource" AS ENUM ('INVITE', 'REGISTRATION');

-- AlterEnum
ALTER TYPE "RsvpFieldType" ADD VALUE 'DOCUMENT';

-- AlterTable
ALTER TABLE "RsvpField" ADD COLUMN     "description" TEXT;

-- CreateTable
CREATE TABLE "GuestDocument" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "rsvpFieldId" TEXT NOT NULL,
    "inviteId" TEXT,
    "source" "GuestDocumentSource" NOT NULL,
    "cloudinaryPublicId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachedAt" TIMESTAMP(3),
    "deleteRequestedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "lastDeleteError" TEXT,

    CONSTRAINT "GuestDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestDocument_cloudinaryPublicId_key" ON "GuestDocument"("cloudinaryPublicId");

-- CreateIndex
CREATE INDEX "GuestDocument_eventId_idx" ON "GuestDocument"("eventId");

-- CreateIndex
CREATE INDEX "GuestDocument_inviteId_idx" ON "GuestDocument"("inviteId");

-- CreateIndex
CREATE INDEX "GuestDocument_deletedAt_attachedAt_uploadedAt_idx" ON "GuestDocument"("deletedAt", "attachedAt", "uploadedAt");

-- AddForeignKey
ALTER TABLE "GuestDocument" ADD CONSTRAINT "GuestDocument_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestDocument" ADD CONSTRAINT "GuestDocument_rsvpFieldId_fkey" FOREIGN KEY ("rsvpFieldId") REFERENCES "RsvpField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestDocument" ADD CONSTRAINT "GuestDocument_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

