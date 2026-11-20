-- Additive data repair (no schema change). Tenants left on Spark with no live
-- subscription whose billing fields still describe one (a cancelled plan past
-- its end, a subscription disabled by Paystack, the pre-release-1
-- subscription.disable handler that matched by email alone and marked a Spark
-- tenant "cancelling") have those fields cleared: tier SPARK, no period, no
-- period end, not cancelling, no pending downgrade, no grace, no stale
-- subscription code. Each repaired tenant gets one SUBSCRIPTION_SYNC_CORRECTED
-- ledger row (changes SETTLED_ON_SPARK, reason MIGRATION, its fields before).
-- The customer code, saved card and any pending checkout are kept.
--
-- The WHERE is subscription-state.util.ts's needsSettlingOnSpark, at the
-- moment the migration runs (the hourly sweep keeps it true afterwards):
--   not a live subscription (a code, not cancelled, a paid tier),
--   on Spark now (resolveEffectiveTier: Spark; cancelled with its period over
--     or without one; grace over; or the hard stop, 5 days past the period
--     end, not waiting for the sync),
--   not a refund waiting to be disabled at Paystack (Spark, a code, not
--     cancelling),
--   and something stale to clear.
-- scripts/sql/subscription-state-check.sql counts the rows first (read-only).

WITH targets AS (
  SELECT "id", "subscriptionTier", "subscriptionPeriod", "subscriptionCurrentPeriodEnd", "subscriptionCancelAtPeriodEnd",
         "subscriptionPendingTierAfterPeriodEnd", "subscriptionGraceStartedAt", "paystackSubscriptionCode"
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
  FOR UPDATE
),
logged AS (
  INSERT INTO "PaymentLedgerEntry" ("id", "type", "amountCents", "currency", "tenantId", "paystackReference", "relatedType", "relatedId", "payload", "occurredAt", "createdAt")
  SELECT 'settle_' || replace(gen_random_uuid()::text, '-', ''), 'SUBSCRIPTION_SYNC_CORRECTED', 0, 'ZAR', t."id", t."paystackSubscriptionCode", 'Tenant', t."id",
         jsonb_build_object(
           'changes', jsonb_build_array('SETTLED_ON_SPARK'),
           'reason', 'MIGRATION',
           'before', jsonb_build_object(
             'tier', t."subscriptionTier",
             'period', t."subscriptionPeriod",
             'currentPeriodEnd', t."subscriptionCurrentPeriodEnd",
             'cancelAtPeriodEnd', t."subscriptionCancelAtPeriodEnd",
             'pendingTierAfterPeriodEnd', t."subscriptionPendingTierAfterPeriodEnd",
             'graceStartedAt', t."subscriptionGraceStartedAt",
             'subscriptionCode', t."paystackSubscriptionCode"
           )
         ),
         now(), now()
  FROM targets t
  RETURNING "tenantId"
)
UPDATE "Tenant" SET
  "subscriptionTier" = 'SPARK',
  "subscriptionPeriod" = NULL,
  "subscriptionCurrentPeriodEnd" = NULL,
  "subscriptionCancelAtPeriodEnd" = false,
  "subscriptionPendingTierAfterPeriodEnd" = NULL,
  "subscriptionGraceStartedAt" = NULL,
  "paystackSubscriptionCode" = NULL,
  "paystackSubscriptionEmailToken" = NULL
WHERE "id" IN (SELECT "tenantId" FROM logged);
