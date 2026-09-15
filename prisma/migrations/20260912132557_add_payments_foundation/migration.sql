-- CreateEnum
CREATE TYPE "PaystackSubaccountStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TICKET_PAYMENT_INITIATED', 'TICKET_PAYMENT_SUCCEEDED', 'TICKET_PAYMENT_FAILED', 'COMMISSION_TAKEN', 'SUBSCRIPTION_CHARGE_INITIATED', 'SUBSCRIPTION_CHARGE_SUCCEEDED', 'SUBSCRIPTION_CHARGE_FAILED', 'REFUND_ISSUED', 'WEBHOOK_EVENT_UNHANDLED', 'WEBHOOK_EVENT_DUPLICATE');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "paystackBusinessName" TEXT,
ADD COLUMN     "paystackSettlementBankCode" TEXT,
ADD COLUMN     "paystackSettlementBankName" TEXT,
ADD COLUMN     "paystackSubaccountCode" TEXT,
ADD COLUMN     "paystackSubaccountFailureReason" TEXT,
ADD COLUMN     "paystackSubaccountStatus" "PaystackSubaccountStatus" NOT NULL DEFAULT 'NOT_STARTED';

-- CreateTable
CREATE TABLE "PaymentLedgerEntry" (
    "id" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "tenantId" TEXT,
    "eventId" TEXT,
    "paystackReference" TEXT,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaystackWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaystackWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_tenantId_occurredAt_idx" ON "PaymentLedgerEntry"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_eventId_occurredAt_idx" ON "PaymentLedgerEntry"("eventId", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_paystackReference_idx" ON "PaymentLedgerEntry"("paystackReference");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_type_occurredAt_idx" ON "PaymentLedgerEntry"("type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaystackWebhookEvent_dedupeKey_key" ON "PaystackWebhookEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "PaystackWebhookEvent_eventType_receivedAt_idx" ON "PaystackWebhookEvent"("eventType", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_paystackSubaccountCode_key" ON "Tenant"("paystackSubaccountCode");

-- AddForeignKey
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

