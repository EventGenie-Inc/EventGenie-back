-- ─────────────────────────────────────────
--  CARD UPDATE EVENTS — READ-ONLY CHECK (fix/payments-go-live, ticket 8)
--
--  For one tenant, every ledger row on 22 Nov 2026 (UTC) that could be the
--  "Update Card" verification charge (Paystack charges the new card R1 and
--  refunds it at once) or its refund, with the Paystack payload fields that
--  mark them. Paystack's docs say the charge happens and is refunded, but
--  document no field that marks either: the stored payloads are where the
--  real fields are.
--
--  Writes nothing: one READ ONLY transaction, ending in ROLLBACK. The
--  customer object (email, phone, name) is removed from every payload printed;
--  card display fields (brand, last 4, expiry, bin) are kept.
--
--    psql "$DATABASE_URL" -v tenant_id=<the tenant's id> -f scripts/sql/card-update-events-check.sql
--
--  Where the payload sits: a SUBSCRIPTION_CHARGE_SUCCEEDED row stores
--  Paystack's `data` as the payload itself; PAYMENT_AMOUNT_MISMATCH,
--  PAYMENT_DUPLICATE and REFUND_* rows store the whole webhook under
--  `provider` (provider.event, provider.data); WEBHOOK_EVENT_UNHANDLED and
--  WEBHOOK_EVENT_IGNORED store the whole webhook as the payload. (A READ ONLY
--  transaction can't CREATE anything, a temp view included, so each query
--  repeats its CTE.)
--
--  The tenant's rows are its own (tenantId) AND rows nothing tied to a
--  tenant that name its subscription code in Paystack's note or carry its
--  customer code: before this fix the card-update refund matched no payment,
--  so it was recorded with no tenant (and its `customer` is {}).
--
--  What the run on dev (tenant cmure4r4s00002dn754wpablu) showed:
--  - no charge.success for the R1 at all; the charges (Paystack transactions
--    6788388411 and 6788389526, references T361996336318561 and
--    T852090576964692) were read from Paystack's test-mode records instead:
--    channel card, metadata.transaction_type "update_card", the subscription
--    code in metadata.custom_fields, plan {};
--  - two refund.pending and two refund.processed, R1 each, tenant NULL,
--    REFUND_PENDING / REFUND_ISSUED with matched:false (each processed one
--    alerted "A refund matched no payment we know"), merchant_note and
--    customer_note "Refund for update card charge [Subscription: SUB_…]";
--  - the 22 Nov reconciliation: two REFUND_NOT_RECORDED mismatches.
--
--  1. The tenant's rows that day, smallest amounts first.
--  2. Their marker fields, one column each.
--  3. The full payloads (customer removed) of the rows under R10.
-- ─────────────────────────────────────────

BEGIN READ ONLY;

-- 1. The tenant's rows that day.
WITH t AS (
  SELECT "id", "paystackSubscriptionCode" AS sub, "paystackCustomerCode" AS cus FROM "Tenant" WHERE "id" = :'tenant_id'
), rows AS (
  SELECT e.*
  FROM "PaymentLedgerEntry" e, t
  WHERE e."createdAt" >= TIMESTAMPTZ '2026-11-22 00:00:00+00'
    AND e."createdAt" <  TIMESTAMPTZ '2026-11-23 00:00:00+00'
    AND (
      e."tenantId" = t."id"
      OR (e."tenantId" IS NULL AND (
        (t.sub IS NOT NULL AND COALESCE(e."payload"->'provider'->'data'->>'merchant_note', e."payload"->'data'->>'merchant_note', '') LIKE '%' || t.sub || '%')
        OR (t.cus IS NOT NULL AND t.cus IN (
          e."payload"->'provider'->'data'->'customer'->>'customer_code',
          e."payload"->'data'->'customer'->>'customer_code',
          e."payload"->'customer'->>'customer_code'
        ))
      ))
    )
)
SELECT "createdAt", "type", COALESCE("payload"->'provider'->>'event', "payload"->>'event', "relatedId") AS "event",
       "amountCents", "currency", "tenantId" IS NOT NULL AS "hasTenant", "paystackReference", "paystackTransactionId", "relatedType"
FROM rows
ORDER BY "amountCents" ASC, "createdAt" ASC;

-- 2. The marker fields. A charge: channel, metadata (transaction_type,
--    custom_fields), plan. A refund: the notes and the refunded transaction.
WITH t AS (
  SELECT "id", "paystackSubscriptionCode" AS sub, "paystackCustomerCode" AS cus FROM "Tenant" WHERE "id" = :'tenant_id'
), rows AS (
  SELECT e."createdAt", e."type", e."amountCents", e."tenantId",
         COALESCE(e."payload"->'provider'->>'event', e."payload"->>'event', e."relatedId") AS "event",
         (CASE
            WHEN e."payload" ? 'provider' AND jsonb_typeof(e."payload"->'provider'->'data') = 'object' THEN e."payload"->'provider'->'data'
            WHEN e."payload" ? 'event' AND jsonb_typeof(e."payload"->'data') = 'object' THEN e."payload"->'data'
            ELSE e."payload"
          END) - 'customer' AS "data",
         -- Our own fields beside Paystack's (only where Paystack's sit under
         -- `provider`; a success row's payload is Paystack's alone).
         CASE WHEN e."payload" ? 'provider' THEN e."payload" - 'provider' END AS "ourFields"
  FROM "PaymentLedgerEntry" e, t
  WHERE e."createdAt" >= TIMESTAMPTZ '2026-11-22 00:00:00+00'
    AND e."createdAt" <  TIMESTAMPTZ '2026-11-23 00:00:00+00'
    AND (
      e."tenantId" = t."id"
      OR (e."tenantId" IS NULL AND (
        (t.sub IS NOT NULL AND COALESCE(e."payload"->'provider'->'data'->>'merchant_note', e."payload"->'data'->>'merchant_note', '') LIKE '%' || t.sub || '%')
        OR (t.cus IS NOT NULL AND t.cus IN (
          e."payload"->'provider'->'data'->'customer'->>'customer_code',
          e."payload"->'data'->'customer'->>'customer_code',
          e."payload"->'customer'->>'customer_code'
        ))
      ))
    )
)
SELECT
  "createdAt",
  "type",
  "event",
  "amountCents",
  "tenantId" IS NOT NULL                AS "hasTenant",
  "data"->>'channel'                    AS "channel",
  "data"->>'status'                     AS "status",
  "data"->'metadata'->>'transaction_type' AS "transactionType",
  "data"->'metadata'->'custom_fields'   AS "customFields",
  "data"->'plan'                        AS "plan",
  "data"->'source'                      AS "source",
  "data"->'authorization'->>'card_type' AS "authBrand",
  "data"->'authorization'->>'last4'     AS "authLast4",
  "data"->'authorization'->>'exp_month' AS "authExpMonth",
  "data"->'authorization'->>'exp_year'  AS "authExpYear",
  "data"->>'merchant_note'              AS "merchantNote",
  "data"->>'customer_note'              AS "customerNote",
  "data"->>'transaction_reference'      AS "refundOfReference",
  "data"->'transaction'                 AS "refundOfTransaction",
  "ourFields"
FROM rows
WHERE "amountCents" < 1000
   OR "type" IN ('SUBSCRIPTION_CHARGE_SUCCEEDED', 'REFUND_ISSUED', 'REFUND_PENDING', 'REFUND_FAILED', 'PAYMENT_AMOUNT_MISMATCH', 'WEBHOOK_EVENT_UNHANDLED')
ORDER BY "createdAt" ASC;

-- 3. Full payloads (customer removed) of the small rows: every field.
WITH t AS (
  SELECT "id", "paystackSubscriptionCode" AS sub, "paystackCustomerCode" AS cus FROM "Tenant" WHERE "id" = :'tenant_id'
), rows AS (
  SELECT e."createdAt", e."type", e."amountCents",
         COALESCE(e."payload"->'provider'->>'event', e."payload"->>'event', e."relatedId") AS "event",
         e."payload" #- '{provider,data,customer}' #- '{data,customer}' #- '{customer}' AS "payload"
  FROM "PaymentLedgerEntry" e, t
  WHERE e."createdAt" >= TIMESTAMPTZ '2026-11-22 00:00:00+00'
    AND e."createdAt" <  TIMESTAMPTZ '2026-11-23 00:00:00+00'
    AND e."amountCents" < 1000
    AND (
      e."tenantId" = t."id"
      OR (e."tenantId" IS NULL AND (
        (t.sub IS NOT NULL AND COALESCE(e."payload"->'provider'->'data'->>'merchant_note', e."payload"->'data'->>'merchant_note', '') LIKE '%' || t.sub || '%')
        OR (t.cus IS NOT NULL AND t.cus IN (
          e."payload"->'provider'->'data'->'customer'->>'customer_code',
          e."payload"->'data'->'customer'->>'customer_code',
          e."payload"->'customer'->>'customer_code'
        ))
      ))
    )
)
SELECT "createdAt", "type", "event", "amountCents", jsonb_pretty("payload") AS "payload"
FROM rows
ORDER BY "createdAt" ASC;

ROLLBACK;
