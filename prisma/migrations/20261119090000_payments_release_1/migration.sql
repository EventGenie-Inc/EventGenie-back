-- ─────────────────────────────────────────
--  PAYMENTS RELEASE 1 — subscriptions, Event Passes and SMS bundles ready
--  for live payments: refunds, chargebacks, amount checks, reuse of a
--  pending checkout, the subscription sync and the daily reconciliation.
--
--  Additive only: new enum values (PaymentAttemptStatus REFUNDED, REVERSED,
--  UNDER_REVIEW; eleven LedgerEntryType values), new nullable columns plus
--  one boolean with a default (Tenant.subscriptionNeedsSync, false), and two
--  new tables (PaymentReconciliationRun, PaymentMismatch). No existing row
--  is changed. PostgreSQL 12 or later (several enum values in one
--  migration; none is used in it).
-- ─────────────────────────────────────────

-- AlterEnum

ALTER TYPE "PaymentAttemptStatus" ADD VALUE 'REFUNDED';
ALTER TYPE "PaymentAttemptStatus" ADD VALUE 'REVERSED';
ALTER TYPE "PaymentAttemptStatus" ADD VALUE 'UNDER_REVIEW';

-- AlterEnum

ALTER TYPE "LedgerEntryType" ADD VALUE 'REFUND_PENDING';
ALTER TYPE "LedgerEntryType" ADD VALUE 'REFUND_FAILED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DISPUTE_OPENED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DISPUTE_REMINDER';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DISPUTE_WON';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DISPUTE_LOST';
ALTER TYPE "LedgerEntryType" ADD VALUE 'PAYMENT_AMOUNT_MISMATCH';
ALTER TYPE "LedgerEntryType" ADD VALUE 'SUBSCRIPTION_CHARGE_UNCERTAIN';
ALTER TYPE "LedgerEntryType" ADD VALUE 'SUBSCRIPTION_DUPLICATE_DETECTED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'SUBSCRIPTION_SYNC_CORRECTED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WEBHOOK_EVENT_IGNORED';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "subscriptionLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionNeedsSync" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subscriptionPendingAuthorizationUrl" TEXT,
ADD COLUMN     "subscriptionPendingStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EventPassPurchase" ADD COLUMN     "authorizationUrl" TEXT,
ADD COLUMN     "paystackTransactionId" TEXT;

-- AlterTable
ALTER TABLE "EventSmsBundlePurchase" ADD COLUMN     "authorizationUrl" TEXT,
ADD COLUMN     "paystackTransactionId" TEXT;

-- AlterTable
ALTER TABLE "PaymentLedgerEntry" ADD COLUMN     "paystackTransactionId" TEXT;

-- CreateTable
CREATE TABLE "PaymentReconciliationRun" (
    "id" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "mismatchCount" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,

    CONSTRAINT "PaymentReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMismatch" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "paystackReference" TEXT,
    "paystackTransactionId" TEXT,
    "tenantId" TEXT,
    "eventId" TEXT,
    "expectedAmountCents" INTEGER,
    "actualAmountCents" INTEGER,
    "currency" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentMismatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReconciliationRun_runDate_key" ON "PaymentReconciliationRun"("runDate");

-- CreateIndex
CREATE INDEX "PaymentMismatch_resolvedAt_createdAt_idx" ON "PaymentMismatch"("resolvedAt", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentMismatch_paystackReference_idx" ON "PaymentMismatch"("paystackReference");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_paystackTransactionId_idx" ON "PaymentLedgerEntry"("paystackTransactionId");

-- AddForeignKey
ALTER TABLE "PaymentMismatch" ADD CONSTRAINT "PaymentMismatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaymentReconciliationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

