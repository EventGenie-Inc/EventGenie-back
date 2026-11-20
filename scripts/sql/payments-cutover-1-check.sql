-- ─────────────────────────────────────────
--  PAYMENTS LIVE CUTOVER — STEP 1: READ-ONLY CHECK (payments release 1)
--
--  Run against PRODUCTION, read-only, BEFORE switching to live keys. It
--  changes nothing (every statement is a SELECT, inside a READ ONLY
--  transaction). It lists what test mode left behind: Paystack codes that
--  belong to test mode (a test-mode customer, subscription, card or
--  subaccount code means nothing to live Paystack), purchases and ledger
--  rows from test payments, and tiers or passes those test payments gave.
--
--  Read the results, then decide what step 2 (payments-cutover-2-reset.sql)
--  should do. Nothing here or there is run by the app or by an agent.
--
--    psql "$PROD_DATABASE_URL" -f scripts/sql/payments-cutover-1-check.sql
-- ─────────────────────────────────────────

BEGIN TRANSACTION READ ONLY;

-- 1. Tenants holding any Paystack billing code or a pending checkout.
SELECT "id", "name", "email", "subscriptionTier", "subscriptionPeriod",
       "subscriptionCurrentPeriodEnd", "subscriptionCancelAtPeriodEnd",
       "paystackCustomerCode", "paystackSubscriptionCode",
       ("paystackSubscriptionEmailToken" IS NOT NULL) AS "hasEmailToken",
       ("paystackAuthorizationCode" IS NOT NULL)       AS "hasSavedCard",
       "subscriptionPendingReference", "subscriptionPendingTier"
FROM "Tenant"
WHERE "paystackCustomerCode" IS NOT NULL
   OR "paystackSubscriptionCode" IS NOT NULL
   OR "paystackAuthorizationCode" IS NOT NULL
   OR "subscriptionPendingReference" IS NOT NULL
ORDER BY "name";

-- 2. Tenants on a paid tier through a (test-mode) Paystack subscription:
--    the tier a test payment gave them. Decide per tenant in step 2.
SELECT "id", "name", "subscriptionTier", "subscriptionPeriod", "paystackSubscriptionCode", "customTierId"
FROM "Tenant"
WHERE "subscriptionTier" <> 'SPARK' AND "paystackSubscriptionCode" IS NOT NULL
ORDER BY "name";

-- 3. Tenants with a payout subaccount (test-mode codes): must re-onboard in
--    live mode before selling tickets.
SELECT "id", "name", "paystackSubaccountStatus", "paystackSubaccountCode",
       "paystackSettlementBankName", "paystackAccountNumberLast4"
FROM "Tenant"
WHERE "paystackSubaccountCode" IS NOT NULL OR "paystackSubaccountStatus" <> 'NOT_STARTED'
ORDER BY "name";

-- 4. Event Pass and SMS bundle purchases, by status (all from test mode).
SELECT 'EventPassPurchase' AS "table", "status", count(*) AS "rows", sum("amountPaidCents") AS "cents"
FROM "EventPassPurchase" GROUP BY "status"
UNION ALL
SELECT 'EventSmsBundlePurchase', "status", count(*), sum("amountPaidCents")
FROM "EventSmsBundlePurchase" GROUP BY "status"
ORDER BY 1, 2;

-- 5. Events holding an Event Pass, and whether a PAID purchase backs it.
SELECT p."eventId", e."name" AS "event", t."name" AS "tenant", p."passTier", p."createdAt",
       EXISTS (SELECT 1 FROM "EventPassPurchase" pp WHERE pp."eventId" = p."eventId" AND pp."status" = 'PAID') AS "hasPaidPurchase"
FROM "EventPass" p
JOIN "Event" e ON e."id" = p."eventId"
JOIN "Tenant" t ON t."id" = p."tenantId"
ORDER BY p."createdAt";

-- 6. Ticket purchases, by status.
SELECT "status", count(*) AS "rows", sum("totalPaid") AS "rand"
FROM "TicketPurchase" GROUP BY "status" ORDER BY 1;

-- 7. The ledger and the webhook dedupe table: how much test history there is.
SELECT "type", count(*) AS "rows", min("occurredAt") AS "first", max("occurredAt") AS "last"
FROM "PaymentLedgerEntry" GROUP BY "type" ORDER BY "type";

SELECT count(*) AS "webhookDedupeRows", min("receivedAt") AS "first", max("receivedAt") AS "last"
FROM "PaystackWebhookEvent";

-- 8. The tier settings the cutover depends on (Elevate's SMS limit: 1000).
SELECT "tier", "maxSmsPerMonth", "smsEnabled", "paidTicketingEnabled"
FROM "SubscriptionTierConfig" ORDER BY "tier";

ROLLBACK;
