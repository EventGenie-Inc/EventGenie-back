-- The daily limit on invitation and reminder emails per event
-- (event-email-limit.util.ts). EventEmailClaim is append-only (see
-- schema.prisma): one row per send, written before its emails go, never
-- updated. Schema only, no data: it starts empty, so every event starts
-- with its full allowance.

-- CreateEnum
CREATE TYPE "EventEmailKind" AS ENUM ('INVITATION', 'REMINDER');

-- CreateTable
CREATE TABLE "EventEmailClaim" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "EventEmailKind" NOT NULL,
    "emailCount" INTEGER NOT NULL,
    "claimedBy" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventEmailClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventEmailClaim_eventId_claimedAt_idx" ON "EventEmailClaim"("eventId", "claimedAt");

-- AddForeignKey
ALTER TABLE "EventEmailClaim" ADD CONSTRAINT "EventEmailClaim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
