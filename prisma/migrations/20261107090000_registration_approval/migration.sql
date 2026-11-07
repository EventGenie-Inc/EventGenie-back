-- Public registration: organiser approval (additive only).
-- Every existing event keeps today's behaviour: auto-approve on.
ALTER TABLE "Event" ADD COLUMN "registrationAutoApprove" BOOLEAN NOT NULL DEFAULT true;

-- Every existing guest is not awaiting approval.
ALTER TABLE "Guest" ADD COLUMN "pendingApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Guest" ADD COLUMN "registrationApprovedAt" TIMESTAMP(3);
ALTER TABLE "Guest" ADD COLUMN "registrationDeclinedAt" TIMESTAMP(3);
ALTER TABLE "Guest" ADD COLUMN "registrationDecidedBy" TEXT;

-- The organiser's pending list: only the few pending rows are indexed.
CREATE INDEX "Guest_eventId_pendingApproval_idx" ON "Guest"("eventId") WHERE "pendingApproval" = true;
