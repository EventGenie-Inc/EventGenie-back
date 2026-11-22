-- Additive only. Ticket sales, Round A (STEERING "Ticket sales").
--
-- 1. Ticket: priceCents (integer cents, the source of truth from now on),
--    backfilled from the old decimal price × 100; the old "price" column
--    stays and is still written in step (deprecated, dropped later). A
--    ticket type's sales window, admitted days, maxPerOrder, sortOrder and
--    ACTIVE/HIDDEN status. Status is backfilled from isAvailable, so an
--    unavailable type stays out of sight.
-- 2. TicketAdmittedDay: the chosen days of a type that doesn't admit every
--    day. Every existing type admits every day (admitsAllDays defaults true).
-- 3. Event.salesPaused: pause ticket sales instead of switching them off.
-- 4. Tenant.paystackSubaccountActiveSince: when the current payout account
--    took effect. Left null for accounts set up before this migration.
-- 5. PayoutAccountChange: a payout account set up or changed, at most one
--    open (CREATING or PENDING) per tenant.
--
-- No existing row loses or changes a value it had.

-- CreateEnum
CREATE TYPE "TicketTypeStatus" AS ENUM ('ACTIVE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "PayoutAccountChangeStatus" AS ENUM ('CREATING', 'PENDING', 'APPLIED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutAccountChangeKind" AS ENUM ('SETUP', 'CHANGE');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "paystackSubaccountActiveSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "salesPaused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: priceCents added nullable, backfilled, then required.
ALTER TABLE "Ticket" ADD COLUMN "priceCents" INTEGER;
UPDATE "Ticket" SET "priceCents" = ROUND("price" * 100)::INTEGER;
ALTER TABLE "Ticket" ALTER COLUMN "priceCents" SET NOT NULL;

ALTER TABLE "Ticket" ADD COLUMN "admitsAllDays" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "salesEnd" TIMESTAMP(3),
ADD COLUMN "salesStart" TIMESTAMP(3),
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "status" "TicketTypeStatus" NOT NULL DEFAULT 'ACTIVE';

UPDATE "Ticket" SET "status" = 'HIDDEN' WHERE "isAvailable" = false;

-- CreateTable
CREATE TABLE "TicketAdmittedDay" (
    "ticketId" TEXT NOT NULL,
    "eventDayId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAdmittedDay_pkey" PRIMARY KEY ("ticketId","eventDayId")
);

-- CreateTable
CREATE TABLE "PayoutAccountChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "PayoutAccountChangeKind" NOT NULL,
    "status" "PayoutAccountChangeStatus" NOT NULL DEFAULT 'CREATING',
    "creationKey" TEXT NOT NULL,
    "subaccountCode" TEXT,
    "subaccountActive" BOOLEAN,
    "businessName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "cancelTokenHash" TEXT,
    "cancelTokenExpiresAt" TIMESTAMP(3),
    "cancelTokenUsedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelledVia" TEXT,
    "appliedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "creationAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutAccountChange_pkey" PRIMARY KEY ("id"),
    -- Only ever the last four digits.
    CONSTRAINT "PayoutAccountChange_last4_check" CHECK ("accountNumberLast4" ~ '^[0-9]{4}$')
);

-- CreateIndex
CREATE INDEX "TicketAdmittedDay_eventDayId_idx" ON "TicketAdmittedDay"("eventDayId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccountChange_creationKey_key" ON "PayoutAccountChange"("creationKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccountChange_subaccountCode_key" ON "PayoutAccountChange"("subaccountCode");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccountChange_cancelTokenHash_key" ON "PayoutAccountChange"("cancelTokenHash");

-- CreateIndex
CREATE INDEX "PayoutAccountChange_tenantId_createdAt_idx" ON "PayoutAccountChange"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "PayoutAccountChange_status_effectiveAt_idx" ON "PayoutAccountChange"("status", "effectiveAt");

-- At most one open change per tenant, however many requests race.
CREATE UNIQUE INDEX "PayoutAccountChange_one_open_per_tenant" ON "PayoutAccountChange"("tenantId")
  WHERE "status" IN ('CREATING', 'PENDING');

-- AddForeignKey
ALTER TABLE "TicketAdmittedDay" ADD CONSTRAINT "TicketAdmittedDay_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAdmittedDay" ADD CONSTRAINT "TicketAdmittedDay_eventDayId_fkey" FOREIGN KEY ("eventDayId") REFERENCES "EventDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAccountChange" ADD CONSTRAINT "PayoutAccountChange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
