-- CreateEnum
CREATE TYPE "SubscriptionPeriod" AS ENUM ('MONTHLY', 'ANNUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerEntryType" ADD VALUE 'SUBSCRIPTION_TIER_CHANGED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'SUBSCRIPTION_CANCELLED';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "paystackAuthorizationCode" TEXT,
ADD COLUMN     "paystackCardBrand" TEXT,
ADD COLUMN     "paystackCardExpMonth" TEXT,
ADD COLUMN     "paystackCardExpYear" TEXT,
ADD COLUMN     "paystackCardLast4" TEXT,
ADD COLUMN     "paystackCustomerCode" TEXT,
ADD COLUMN     "paystackSubscriptionCode" TEXT,
ADD COLUMN     "paystackSubscriptionEmailToken" TEXT,
ADD COLUMN     "subscriptionCancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subscriptionCurrentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "subscriptionGraceStartedAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionPendingPeriod" "SubscriptionPeriod",
ADD COLUMN     "subscriptionPendingReference" TEXT,
ADD COLUMN     "subscriptionPendingTier" "SubscriptionTier",
ADD COLUMN     "subscriptionPendingTierAfterPeriodEnd" "SubscriptionTier",
ADD COLUMN     "subscriptionPeriod" "SubscriptionPeriod";

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_paystackCustomerCode_key" ON "Tenant"("paystackCustomerCode");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_paystackSubscriptionCode_key" ON "Tenant"("paystackSubscriptionCode");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_subscriptionPendingReference_key" ON "Tenant"("subscriptionPendingReference");

