-- ─────────────────────────────────────────
--  SUBSCRIPTION STATE — READ-ONLY CHECK (fix/subscription-state)
--
--  Run on each environment BEFORE deploying the migration
--  20261121100000_settle_ended_subscriptions. Writes nothing: one READ ONLY
--  transaction, ending in ROLLBACK. No email or card detail is printed.
--
--    psql "$DATABASE_URL" -f scripts/sql/subscription-state-check.sql
--
--  1. How many tenants the migration would repair (its exact WHERE), and why.
--  2. Those tenants, with the fields it would clear.
--  3. Unclaimed subscription charges (WEBHOOK_EVENT_UNHANDLED charge.success)
--     that latestPayment can now tie to a tenant safely: by one of its own
--     subscribe references, or by its customer code on a plan charge.
--  4. Unclaimed charges that can't be tied to a tenant safely (left to the
--     reconciliation; check them in Paystack's dashboard).
-- ─────────────────────────────────────────

BEGIN READ ONLY;

-- 1 and 2 use the migration's exact WHERE (settle_targets).

-- 1. The count, and by what each one is.
WITH settle_targets AS (
  SELECT "id", "subscriptionTier", "subscriptionPeriod", "subscriptionCurrentPeriodEnd", "subscriptionCancelAtPeriodEnd",
         "subscriptionPendingTierAfterPeriodEnd", "subscriptionGraceStartedAt",
         "paystackSubscriptionCode" IS NOT NULL AS "hasSubscriptionCode", "customTierId" IS NOT NULL AS "onCustomTier"
  FROM "Tenant"
  WHERE NOT ("paystackSubscriptionCode" IS NOT NULL AND "subscriptionCancelAtPeriodEnd" = false AND "subscriptionTier" <> 'SPARK')
    AND (
      "subscriptionTier" = 'SPARK'
      OR ("subscriptionCancelAtPeriodEnd" = true AND ("subscriptionCurrentPeriodEnd" IS NULL OR "subscriptionCurrentPeriodEnd" <= now()))
      OR ("subscriptionCancelAtPeriodEnd" = false AND "subscriptionGraceStartedAt" IS NOT NULL
          AND "subscriptionGraceStartedAt" + interval '5 days' <= now())
      OR ("subscriptionCancelAtPeriodEnd" = false AND "subscriptionGraceStartedAt" IS NULL AND "subscriptionCurrentPeriodEnd" IS NOT NULL
          AND "subscriptionNeedsSync" = false AND "subscriptionCurrentPeriodEnd" + interval '5 days' <= now())
    )
    AND NOT ("subscriptionTier" = 'SPARK' AND "paystackSubscriptionCode" IS NOT NULL AND "subscriptionCancelAtPeriodEnd" = false)
    AND (
      "subscriptionCancelAtPeriodEnd" = true
      OR "subscriptionPendingTierAfterPeriodEnd" IS NOT NULL
      OR "subscriptionTier" <> 'SPARK'
      OR "subscriptionPeriod" IS NOT NULL
      OR "subscriptionCurrentPeriodEnd" IS NOT NULL
      OR "subscriptionGraceStartedAt" IS NOT NULL
      OR "paystackSubscriptionCode" IS NOT NULL
    )
)
SELECT count(*) AS "tenantsTheMigrationWouldRepair" FROM settle_targets;

WITH settle_targets AS (
  SELECT "id", "subscriptionTier", "subscriptionPeriod", "subscriptionCurrentPeriodEnd", "subscriptionCancelAtPeriodEnd",
         "subscriptionPendingTierAfterPeriodEnd", "subscriptionGraceStartedAt",
         "paystackSubscriptionCode" IS NOT NULL AS "hasSubscriptionCode", "customTierId" IS NOT NULL AS "onCustomTier"
  FROM "Tenant"
  WHERE NOT ("paystackSubscriptionCode" IS NOT NULL AND "subscriptionCancelAtPeriodEnd" = false AND "subscriptionTier" <> 'SPARK')
    AND (
      "subscriptionTier" = 'SPARK'
      OR ("subscriptionCancelAtPeriodEnd" = true AND ("subscriptionCurrentPeriodEnd" IS NULL OR "subscriptionCurrentPeriodEnd" <= now()))
      OR ("subscriptionCancelAtPeriodEnd" = false AND "subscriptionGraceStartedAt" IS NOT NULL
          AND "subscriptionGraceStartedAt" + interval '5 days' <= now())
      OR ("subscriptionCancelAtPeriodEnd" = false AND "subscriptionGraceStartedAt" IS NULL AND "subscriptionCurrentPeriodEnd" IS NOT NULL
          AND "subscriptionNeedsSync" = false AND "subscriptionCurrentPeriodEnd" + interval '5 days' <= now())
    )
    AND NOT ("subscriptionTier" = 'SPARK' AND "paystackSubscriptionCode" IS NOT NULL AND "subscriptionCancelAtPeriodEnd" = false)
    AND (
      "subscriptionCancelAtPeriodEnd" = true
      OR "subscriptionPendingTierAfterPeriodEnd" IS NOT NULL
      OR "subscriptionTier" <> 'SPARK'
      OR "subscriptionPeriod" IS NOT NULL
      OR "subscriptionCurrentPeriodEnd" IS NOT NULL
      OR "subscriptionGraceStartedAt" IS NOT NULL
      OR "paystackSubscriptionCode" IS NOT NULL
    )
)
SELECT
  CASE
    WHEN "subscriptionTier" = 'SPARK' AND "subscriptionCancelAtPeriodEnd" THEN 'Spark, marked cancelling'
    WHEN "subscriptionTier" = 'SPARK' THEN 'Spark, other stale fields'
    WHEN "subscriptionCancelAtPeriodEnd" THEN 'paid tier, cancelled, period over'
    WHEN "subscriptionGraceStartedAt" IS NOT NULL THEN 'paid tier, no live subscription, grace over'
    ELSE 'paid tier, no live subscription, past the hard stop'
  END AS "state",
  count(*) AS "tenants"
FROM settle_targets GROUP BY 1 ORDER BY 1;

-- 2. The tenants.
WITH settle_targets AS (
  SELECT "id", "subscriptionTier", "subscriptionPeriod", "subscriptionCurrentPeriodEnd", "subscriptionCancelAtPeriodEnd",
         "subscriptionPendingTierAfterPeriodEnd", "subscriptionGraceStartedAt",
         "paystackSubscriptionCode" IS NOT NULL AS "hasSubscriptionCode", "customTierId" IS NOT NULL AS "onCustomTier"
  FROM "Tenant"
  WHERE NOT ("paystackSubscriptionCode" IS NOT NULL AND "subscriptionCancelAtPeriodEnd" = false AND "subscriptionTier" <> 'SPARK')
    AND (
      "subscriptionTier" = 'SPARK'
      OR ("subscriptionCancelAtPeriodEnd" = true AND ("subscriptionCurrentPeriodEnd" IS NULL OR "subscriptionCurrentPeriodEnd" <= now()))
      OR ("subscriptionCancelAtPeriodEnd" = false AND "subscriptionGraceStartedAt" IS NOT NULL
          AND "subscriptionGraceStartedAt" + interval '5 days' <= now())
      OR ("subscriptionCancelAtPeriodEnd" = false AND "subscriptionGraceStartedAt" IS NULL AND "subscriptionCurrentPeriodEnd" IS NOT NULL
          AND "subscriptionNeedsSync" = false AND "subscriptionCurrentPeriodEnd" + interval '5 days' <= now())
    )
    AND NOT ("subscriptionTier" = 'SPARK' AND "paystackSubscriptionCode" IS NOT NULL AND "subscriptionCancelAtPeriodEnd" = false)
    AND (
      "subscriptionCancelAtPeriodEnd" = true
      OR "subscriptionPendingTierAfterPeriodEnd" IS NOT NULL
      OR "subscriptionTier" <> 'SPARK'
      OR "subscriptionPeriod" IS NOT NULL
      OR "subscriptionCurrentPeriodEnd" IS NOT NULL
      OR "subscriptionGraceStartedAt" IS NOT NULL
      OR "paystackSubscriptionCode" IS NOT NULL
    )
)
SELECT * FROM settle_targets ORDER BY "id";

-- 3. Unclaimed subscription charges latestPayment now ties to a tenant.
SELECT t."id" AS "tenantId", e."createdAt", e."amountCents", e."paystackReference",
       CASE WHEN own."paystackReference" IS NOT NULL THEN 'own subscribe reference' ELSE 'customer code, plan charge' END AS "matchedBy"
FROM "PaymentLedgerEntry" e
LEFT JOIN "PaymentLedgerEntry" own
  ON own."type" = 'SUBSCRIPTION_CHARGE_INITIATED' AND own."paystackReference" = e."paystackReference" AND own."paystackReference" LIKE 'sub\_%'
JOIN "Tenant" t
  ON t."id" = own."tenantId"
  OR (own."id" IS NULL AND t."paystackCustomerCode" IS NOT NULL
      AND t."paystackCustomerCode" = e."payload"#>>'{data,customer,customer_code}'
      AND e."payload"#>'{data,plan}' IS NOT NULL AND jsonb_typeof(e."payload"#>'{data,plan}') <> 'null')
WHERE e."type" = 'WEBHOOK_EVENT_UNHANDLED' AND e."relatedId" = 'charge.success' AND e."tenantId" IS NULL
  AND e."payload"#>>'{data,status}' = 'success'
ORDER BY e."createdAt" DESC;

-- 4. Unclaimed charges no tenant can be tied to safely.
SELECT count(*) AS "unclaimedChargesLeftToReconciliation"
FROM "PaymentLedgerEntry" e
WHERE e."type" = 'WEBHOOK_EVENT_UNHANDLED' AND e."relatedId" = 'charge.success' AND e."tenantId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "PaymentLedgerEntry" own
    WHERE own."type" = 'SUBSCRIPTION_CHARGE_INITIATED' AND own."paystackReference" = e."paystackReference" AND own."paystackReference" LIKE 'sub\_%')
  AND NOT EXISTS (
    SELECT 1 FROM "Tenant" t
    WHERE t."paystackCustomerCode" IS NOT NULL AND t."paystackCustomerCode" = e."payload"#>>'{data,customer,customer_code}'
      AND e."payload"#>'{data,plan}' IS NOT NULL AND jsonb_typeof(e."payload"#>'{data,plan}') <> 'null');

ROLLBACK;
