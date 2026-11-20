-- ─────────────────────────────────────────
--  PAYMENTS LIVE CUTOVER — STEP 2: RESET TEST-MODE STATE (payments release 1)
--
--  Run against PRODUCTION, by a person, ONCE, after reading step 1's output
--  and BEFORE the deploy that switches to live keys (with `payments` still
--  in FEATURES_DISABLED, so nothing new is bought meanwhile). Take a
--  database snapshot (Neon branch) first.
--
--  What it does, in one transaction that ends in ROLLBACK until you change
--  the last line to COMMIT after reading the counts it prints:
--   A. Forgets every test-mode Paystack identifier on tenants: customer,
--      subscription, email token, saved card, pending checkout. Live
--      Paystack has never heard of them; leaving them would make the sync
--      and verify ask live Paystack about test objects.
--   B. Resets every payout subaccount to NOT_STARTED: organisers re-onboard
--      in live mode (subaccounts are separate per mode).
--   C. Marks test-mode PENDING purchases FAILED, so the stale sweep doesn't
--      ask live Paystack about them.
--   D. (OPTIONAL — commented out) puts tenants whose paid tier came from a
--      test-mode subscription back on Spark, and removes Event Passes that
--      only test payments back. Decide from step 1's lists 2 and 5: a pilot
--      tenant you meant to keep on a plan should be moved to a custom tier
--      (invoiced outside the app) instead.
--
--  What it never does: delete or edit ledger rows (append-only; they stay as
--  the record of what test mode did, with their own dates, before the
--  cutover day the reconciliation starts from), delete purchases, or touch
--  any event, guest or file.
--
--    psql "$PROD_DATABASE_URL" -f scripts/sql/payments-cutover-2-reset.sql
-- ─────────────────────────────────────────

BEGIN;

-- A. Tenants' test-mode billing identifiers.
UPDATE "Tenant" SET
  "paystackCustomerCode" = NULL,
  "paystackSubscriptionCode" = NULL,
  "paystackSubscriptionEmailToken" = NULL,
  "paystackAuthorizationCode" = NULL,
  "paystackCardBrand" = NULL,
  "paystackCardLast4" = NULL,
  "paystackCardExpMonth" = NULL,
  "paystackCardExpYear" = NULL,
  "subscriptionPendingReference" = NULL,
  "subscriptionPendingTier" = NULL,
  "subscriptionPendingPeriod" = NULL,
  "subscriptionPendingAuthorizationUrl" = NULL,
  "subscriptionPendingStartedAt" = NULL,
  "subscriptionNeedsSync" = false,
  "subscriptionGraceStartedAt" = NULL
WHERE "paystackCustomerCode" IS NOT NULL
   OR "paystackSubscriptionCode" IS NOT NULL
   OR "paystackAuthorizationCode" IS NOT NULL
   OR "subscriptionPendingReference" IS NOT NULL;

-- B. Payout subaccounts: re-onboard in live mode.
UPDATE "Tenant" SET
  "paystackSubaccountCode" = NULL,
  "paystackSubaccountStatus" = 'NOT_STARTED',
  "paystackBusinessName" = NULL,
  "paystackSettlementBankCode" = NULL,
  "paystackSettlementBankName" = NULL,
  "paystackAccountNumberLast4" = NULL,
  "paystackAccountHolderName" = NULL,
  "paystackSubaccountFailureReason" = NULL
WHERE "paystackSubaccountCode" IS NOT NULL OR "paystackSubaccountStatus" <> 'NOT_STARTED';

-- C. Test-mode attempts still pending.
UPDATE "EventPassPurchase"      SET "status" = 'FAILED' WHERE "status" = 'PENDING';
UPDATE "EventSmsBundlePurchase" SET "status" = 'FAILED' WHERE "status" = 'PENDING';
UPDATE "TicketPurchase"         SET "status" = 'EXPIRED' WHERE "status" = 'PENDING';
UPDATE "Ticket" SET "heldCount" = 0 WHERE "heldCount" <> 0;

-- D. OPTIONAL — uncomment only after deciding from step 1's lists 2 and 5.
-- Run these BEFORE step A in a second pass if you need the subscription
-- codes to choose the tenants; as written they use the tier alone.
--
-- UPDATE "Tenant" SET
--   "subscriptionTier" = 'SPARK', "subscriptionPeriod" = NULL,
--   "subscriptionCurrentPeriodEnd" = NULL, "subscriptionCancelAtPeriodEnd" = false,
--   "subscriptionPendingTierAfterPeriodEnd" = NULL
-- WHERE "id" IN ('<tenant id>', '<tenant id>');
--
-- UPDATE "EventPassPurchase" SET "eventPassId" = NULL WHERE "eventId" IN ('<event id>');
-- DELETE FROM "EventPass" WHERE "eventId" IN ('<event id>');

-- What changed (read before committing).
SELECT count(*) AS "tenantsStillHoldingPaystackCodes" FROM "Tenant"
WHERE "paystackCustomerCode" IS NOT NULL OR "paystackSubscriptionCode" IS NOT NULL OR "paystackSubaccountCode" IS NOT NULL;
SELECT count(*) AS "pendingPurchasesLeft" FROM "EventPassPurchase" WHERE "status" = 'PENDING';

-- Change to COMMIT once the counts above are what you expect.
ROLLBACK;
