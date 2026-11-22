-- ─────────────────────────────────────────
--  TICKET PURCHASES (THE RETIRED INVITATION PATH) — READ-ONLY CHECK
--  (ticket sales Round B, 2026-11)
--
--  Round B retired buying a ticket through an invitation (an RSVP with a
--  ticket): those endpoints answer 410 TICKET_PURCHASE_RETIRED. Rows it made
--  are kept for history and stay readable to the organiser. This lists them,
--  and every paid private event (which no longer sells anything), so each
--  can be dealt with by hand on staging and production.
--
--  Writes nothing: one READ ONLY transaction, ending in ROLLBACK. No guest
--  contact detail is printed.
--
--    psql "$DATABASE_URL" -f scripts/sql/ticket-purchases-check.sql
--
--  1. TicketPurchase rows by status.
--  2. Each one: its event, organisation, ticket type, amounts and dates.
--  3. Paid private events (as scripts/sql/paid-private-events-check.sql).
-- ─────────────────────────────────────────

BEGIN READ ONLY;

-- 1. How many, by status.
SELECT p."status", COUNT(*) AS "purchases", COALESCE(SUM(p."ticketPriceCents"), 0) AS "ticketPriceCents"
FROM "TicketPurchase" p
GROUP BY p."status"
ORDER BY p."status";

-- 2. Each one.
SELECT
  p."id"                AS "purchaseId",
  p."status",
  p."quantity",
  p."ticketPriceCents",
  p."commissionCents",
  p."totalPaid",
  p."currency",
  p."paymentRef",
  p."purchasedAt",
  p."confirmedAt",
  k."id"                AS "ticketTypeId",
  k."name"              AS "ticketType",
  e."id"                AS "eventId",
  e."name"              AS "eventName",
  e."visibility",
  e."ticketing",
  t."id"                AS "tenantId",
  t."name"              AS "organisation"
FROM "TicketPurchase" p
JOIN "Ticket" k ON k."id" = p."ticketId"
JOIN "Event" e ON e."id" = k."eventId"
JOIN "Tenant" t ON t."id" = e."tenantId"
ORDER BY p."purchasedAt";

-- 3. Paid private events.
SELECT
  e."id" AS "eventId", e."name" AS "eventName", t."id" AS "tenantId", t."name" AS "organisation",
  e."status", e."isArchived", e."createdAt"
FROM "Event" e
JOIN "Tenant" t ON t."id" = e."tenantId"
WHERE e."ticketing" = 'PAID' AND e."visibility" = 'PRIVATE'
ORDER BY e."isArchived", e."createdAt";

ROLLBACK;
