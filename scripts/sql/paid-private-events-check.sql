-- ─────────────────────────────────────────
--  PAID PRIVATE EVENTS — READ-ONLY CHECK (ticket sales Round A, 2026-11)
--
--  Since Round A, tickets are sold for public events only: no path makes a
--  private event paid, a paid event can't be made private, and a paid
--  private DRAFT can't be published. Events made paid and private before
--  that still exist wherever they were made; the invitation purchase path
--  (RSVP with a ticket) keeps working for them until Round B removes it.
--  This lists them, so each can be dealt with by hand before then.
--
--  Writes nothing: one READ ONLY transaction, ending in ROLLBACK. No guest
--  or organiser contact detail is printed. Run on staging and production:
--
--    psql "$DATABASE_URL" -f scripts/sql/paid-private-events-check.sql
--
--  1. How many, by status (archived ones counted apart).
--  2. Each one: its organisation, status, dates, ticket types and their
--     sales, and the invitation purchases made (by status).
-- ─────────────────────────────────────────

BEGIN READ ONLY;

-- 1. How many.
SELECT
  e."status",
  e."isArchived",
  COUNT(*) AS "events"
FROM "Event" e
WHERE e."ticketing" = 'PAID'
  AND e."visibility" = 'PRIVATE'
GROUP BY e."status", e."isArchived"
ORDER BY e."isArchived", e."status";

-- 2. Each one.
SELECT
  e."id"                                    AS "eventId",
  e."name"                                  AS "eventName",
  t."id"                                    AS "tenantId",
  t."name"                                  AS "organisation",
  e."status",
  e."isArchived",
  e."createdAt",
  (SELECT MIN(d."date") FROM "EventDay" d WHERE d."eventId" = e."id" AND d."isArchived" = false) AS "firstDay",
  (SELECT MAX(d."date") FROM "EventDay" d WHERE d."eventId" = e."id" AND d."isArchived" = false) AS "lastDay",
  (SELECT COUNT(*) FROM "Ticket" k WHERE k."eventId" = e."id" AND k."isArchived" = false)        AS "ticketTypes",
  (SELECT COALESCE(SUM(k."soldCount"), 0) FROM "Ticket" k WHERE k."eventId" = e."id")             AS "ticketsSold",
  (SELECT COUNT(*) FROM "TicketPurchase" p JOIN "Ticket" k ON k."id" = p."ticketId"
     WHERE k."eventId" = e."id" AND p."status" = 'PAID')                                           AS "purchasesPaid",
  (SELECT COUNT(*) FROM "TicketPurchase" p JOIN "Ticket" k ON k."id" = p."ticketId"
     WHERE k."eventId" = e."id" AND p."status" = 'PENDING')                                        AS "purchasesPending",
  (SELECT COUNT(*) FROM "TicketPurchase" p JOIN "Ticket" k ON k."id" = p."ticketId"
     WHERE k."eventId" = e."id" AND p."status" IN ('FAILED', 'EXPIRED'))                           AS "purchasesFailedOrExpired"
FROM "Event" e
JOIN "Tenant" t ON t."id" = e."tenantId"
WHERE e."ticketing" = 'PAID'
  AND e."visibility" = 'PRIVATE'
ORDER BY e."isArchived", e."createdAt";

ROLLBACK;
