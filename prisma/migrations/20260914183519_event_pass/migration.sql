-- CreateEnum
CREATE TYPE "EventPassTier" AS ENUM ('SMALL', 'STANDARD', 'LARGE');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "SmsSendSource" AS ENUM ('QUOTA', 'BUNDLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerEntryType" ADD VALUE 'EVENT_PASS_PURCHASE_INITIATED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'EVENT_PASS_PURCHASE_SUCCEEDED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'EVENT_PASS_PURCHASE_FAILED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'SMS_BUNDLE_PURCHASE_INITIATED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'SMS_BUNDLE_PURCHASE_SUCCEEDED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'SMS_BUNDLE_PURCHASE_FAILED';

-- AlterTable
ALTER TABLE "SmsSendLog" ADD COLUMN     "eventId" TEXT,
ADD COLUMN     "source" "SmsSendSource" NOT NULL DEFAULT 'QUOTA';

-- CreateTable
CREATE TABLE "EventPass" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "passTier" "EventPassTier" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventPass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventPassPurchase" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventPassId" TEXT,
    "passTier" "EventPassTier" NOT NULL,
    "isUpgrade" BOOLEAN NOT NULL DEFAULT false,
    "amountPaidCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "paymentRef" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMP(3),
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventPassPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSmsBundlePurchase" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "smsCount" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "paymentRef" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMP(3),
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventSmsBundlePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventPass_eventId_key" ON "EventPass"("eventId");

-- CreateIndex
CREATE INDEX "EventPass_tenantId_idx" ON "EventPass"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EventPassPurchase_paymentRef_key" ON "EventPassPurchase"("paymentRef");

-- CreateIndex
CREATE INDEX "EventPassPurchase_eventId_idx" ON "EventPassPurchase"("eventId");

-- CreateIndex
CREATE INDEX "EventPassPurchase_tenantId_idx" ON "EventPassPurchase"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EventSmsBundlePurchase_paymentRef_key" ON "EventSmsBundlePurchase"("paymentRef");

-- CreateIndex
CREATE INDEX "EventSmsBundlePurchase_eventId_idx" ON "EventSmsBundlePurchase"("eventId");

-- CreateIndex
CREATE INDEX "EventSmsBundlePurchase_tenantId_idx" ON "EventSmsBundlePurchase"("tenantId");

-- CreateIndex
CREATE INDEX "SmsSendLog_eventId_source_idx" ON "SmsSendLog"("eventId", "source");

-- AddForeignKey
ALTER TABLE "SmsSendLog" ADD CONSTRAINT "SmsSendLog_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPass" ADD CONSTRAINT "EventPass_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPass" ADD CONSTRAINT "EventPass_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPassPurchase" ADD CONSTRAINT "EventPassPurchase_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPassPurchase" ADD CONSTRAINT "EventPassPurchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPassPurchase" ADD CONSTRAINT "EventPassPurchase_eventPassId_fkey" FOREIGN KEY ("eventPassId") REFERENCES "EventPass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSmsBundlePurchase" ADD CONSTRAINT "EventSmsBundlePurchase_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSmsBundlePurchase" ADD CONSTRAINT "EventSmsBundlePurchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
