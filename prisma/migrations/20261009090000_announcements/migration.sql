-- Announcements: an organiser's email to their guests, and the automatic
-- email sent when an event is cancelled. Both tables are append-only (see
-- schema.prisma): an Announcement is written when the send is claimed, one
-- AnnouncementDelivery per guest once their email has gone or failed, and
-- neither is ever updated. Schema only, no data: both start empty.

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('EVERYONE', 'ATTENDING', 'NOT_REPLIED', 'NOT_ATTENDING');

-- CreateEnum
CREATE TYPE "AnnouncementKind" AS ENUM ('ANNOUNCEMENT', 'CANCELLATION');

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "AnnouncementKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "audience" "AnnouncementAudience" NOT NULL,
    "eventDayId" TEXT,
    "sentBy" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipientCount" INTEGER NOT NULL,
    "unreachableCount" INTEGER NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementDelivery" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_eventId_sentAt_idx" ON "Announcement"("eventId", "sentAt");

-- CreateIndex
CREATE INDEX "AnnouncementDelivery_announcementId_idx" ON "AnnouncementDelivery"("announcementId");

-- CreateIndex
CREATE INDEX "AnnouncementDelivery_guestId_idx" ON "AnnouncementDelivery"("guestId");

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_eventDayId_fkey" FOREIGN KEY ("eventDayId") REFERENCES "EventDay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementDelivery" ADD CONSTRAINT "AnnouncementDelivery_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementDelivery" ADD CONSTRAINT "AnnouncementDelivery_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
