-- Feedback and sharing permissions (the `feedback` flag).
--
-- ConsentRecord is APPEND-ONLY (schema.prisma): every permission given or
-- withdrawn is a new row, and a subject's current state is its latest row
-- by "seq". EventFeedback holds one event's answers. FeedbackRequestClaim
-- is the once-per-event claim on the "How did <event> go?" email: its
-- unique eventId is what stops two sweeps sending it twice.
--
-- Schema only, no data: every table starts empty, so nothing has been
-- granted and no event has been asked yet.
--
-- Beyond what Prisma can express (added by hand at the end):
--   - CHECK constraints: exactly one of userId/guestId says who; the photo
--     kinds name a photo and the event-level kinds don't; a guest only
--     ever records PHOTO_GUEST_PUBLIC_SHARING and an organiser never does.
--   - A trigger refusing any UPDATE of a ConsentRecord, so a record can't
--     be rewritten even by a query outside consent.repository.ts. DELETE is
--     left to the foreign keys' ON DELETE CASCADE, which only a hard-deleted
--     test fixture ever triggers.

-- CreateEnum
CREATE TYPE "ConsentKind" AS ENUM ('COMPANY_NAME_LOGO', 'QUOTE', 'CASE_STUDY_CONTACT', 'PHOTO_ORGANISER_SELECTED', 'PHOTO_GUEST_PUBLIC_SHARING');

-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "ConsentKind" NOT NULL,
    "memoryItemId" TEXT,
    "userId" TEXT,
    "guestId" TEXT,
    "action" "ConsentAction" NOT NULL,
    "wording" TEXT NOT NULL,
    "wordingVersion" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventFeedback" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "workedBest" TEXT,
    "toImprove" TEXT,
    "logoUrl" TEXT,
    "logoPublicId" TEXT,
    "submittedBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackRequestClaim" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackRequestClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsentRecord_seq_key" ON "ConsentRecord"("seq");

-- CreateIndex
CREATE INDEX "ConsentRecord_eventId_seq_idx" ON "ConsentRecord"("eventId", "seq");

-- CreateIndex
CREATE INDEX "ConsentRecord_memoryItemId_idx" ON "ConsentRecord"("memoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "EventFeedback_eventId_key" ON "EventFeedback"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequestClaim_eventId_key" ON "FeedbackRequestClaim"("eventId");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_memoryItemId_fkey" FOREIGN KEY ("memoryItemId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventFeedback" ADD CONSTRAINT "EventFeedback_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventFeedback" ADD CONSTRAINT "EventFeedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRequestClaim" ADD CONSTRAINT "FeedbackRequestClaim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Who: exactly one of an organiser or a guest.
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_one_subject_check"
  CHECK (num_nonnulls("userId", "guestId") = 1);

-- What: the photo kinds name a photo; the event-level kinds don't.
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_item_matches_kind_check"
  CHECK (
    ("kind" IN ('PHOTO_ORGANISER_SELECTED', 'PHOTO_GUEST_PUBLIC_SHARING')) = ("memoryItemId" IS NOT NULL)
  );

-- A guest's only permission is their own photo's public sharing, and only
-- a guest gives that one.
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_guest_kind_check"
  CHECK (("kind" = 'PHOTO_GUEST_PUBLIC_SHARING') = ("guestId" IS NOT NULL));

-- Never updated: a change of mind is a new record.
CREATE FUNCTION "ConsentRecord_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ConsentRecord is append-only: record a new consent instead of updating one';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConsentRecord_no_update"
  BEFORE UPDATE ON "ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION "ConsentRecord_refuse_update"();
