-- Additive only. Ticket sales follow-ups: deactivating unused payout
-- subaccounts at Paystack (STEERING "Ticket sales").
--
-- A cancelled or failed change's own subaccount, and the subaccount a change
-- replaced once it took effect, are deactivated at Paystack (best effort,
-- retried by the payout worker). These columns record what was replaced, when
-- each was deactivated, and the retry state. No existing row changes.

ALTER TABLE "PayoutAccountChange"
  ADD COLUMN "subaccountDeactivatedAt" TIMESTAMP(3),
  ADD COLUMN "replacedSubaccountCode" TEXT,
  ADD COLUMN "replacedBusinessName" TEXT,
  ADD COLUMN "replacedBankCode" TEXT,
  ADD COLUMN "replacedDeactivatedAt" TIMESTAMP(3),
  ADD COLUMN "deactivationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextDeactivationAt" TIMESTAMP(3),
  ADD COLUMN "lastDeactivationError" TEXT;
