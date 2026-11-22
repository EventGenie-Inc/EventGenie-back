-- Additive only. QR check-in (STEERING "Check-in", QR check-in).
--
-- 1. CheckInPass: a door code's credential, one per person per event day.
--    Only a credential: whether someone is checked in stays in "CheckIn",
--    so this changes nothing about who has arrived. No existing row is
--    touched; guests who accepted before this migration are given their
--    passes the first time their invitation asks for them.
-- 2. qrCheckInEnabled on every plan: on for every standard tier (Spark,
--    Celebrate, Elevate; an Event Pass maps to one of these) and every
--    custom tier (Free trial included), set explicitly per tier as STEERING
--    "Tier enforcement" asks of a new tier column.

-- CreateEnum
CREATE TYPE "CheckInPassKind" AS ENUM ('RSVP');

-- CreateEnum
CREATE TYPE "CheckInPassStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "CheckInPass" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventDayId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "plusOneGuestId" TEXT,
    "kind" "CheckInPassKind" NOT NULL,
    "status" "CheckInPassStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckInPass_pkey" PRIMARY KEY ("id"),
    -- Revoked exactly when it has a revokedAt.
    CONSTRAINT "CheckInPass_revoked_check" CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)),
    -- A plus-one is never their own host.
    CONSTRAINT "CheckInPass_plus_one_check" CHECK ("plusOneGuestId" IS NULL OR "plusOneGuestId" <> "guestId")
);

-- CreateIndex
CREATE INDEX "CheckInPass_guestId_status_idx" ON "CheckInPass"("guestId", "status");

-- CreateIndex
CREATE INDEX "CheckInPass_plusOneGuestId_idx" ON "CheckInPass"("plusOneGuestId");

-- CreateIndex
CREATE INDEX "CheckInPass_eventDayId_idx" ON "CheckInPass"("eventDayId");

-- At most one ACTIVE pass per person per day, whoever issues it and
-- however many requests race: the person is the plus-one when there is one,
-- else the guest. Revoked passes are kept and don't count.
CREATE UNIQUE INDEX "CheckInPass_one_active_per_person_day"
  ON "CheckInPass"("eventDayId", COALESCE("plusOneGuestId", "guestId"))
  WHERE "status" = 'ACTIVE';

-- AddForeignKey (cascade only so test fixtures can be removed; the app never
-- hard-deletes a guest, day or event)
ALTER TABLE "CheckInPass" ADD CONSTRAINT "CheckInPass_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInPass" ADD CONSTRAINT "CheckInPass_eventDayId_fkey" FOREIGN KEY ("eventDayId") REFERENCES "EventDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInPass" ADD CONSTRAINT "CheckInPass_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInPass" ADD CONSTRAINT "CheckInPass_plusOneGuestId_fkey" FOREIGN KEY ("plusOneGuestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Plan setting: on everywhere.
ALTER TABLE "SubscriptionTierConfig" ADD COLUMN "qrCheckInEnabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "SubscriptionTierConfig" SET "qrCheckInEnabled" = true WHERE "tier" = 'SPARK';
UPDATE "SubscriptionTierConfig" SET "qrCheckInEnabled" = true WHERE "tier" = 'CELEBRATE';
UPDATE "SubscriptionTierConfig" SET "qrCheckInEnabled" = true WHERE "tier" = 'ELEVATE';

ALTER TABLE "CustomTier" ADD COLUMN "qrCheckInEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Every custom tier, the Free trial ('custom_free_trial') included.
UPDATE "CustomTier" SET "qrCheckInEnabled" = true;
