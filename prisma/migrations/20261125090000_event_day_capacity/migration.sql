-- ─────────────────────────────────────────
--  VENUE CAPACITY PER EVENT DAY (hotfix/day-capacity). Additive only.
--
--  Each day has its own venue, so each day has its own capacity. One new
--  nullable column (null = no limit), a CHECK that keeps it a sane number
--  and null on an ONLINE day, and a backfill: every event with a capacity
--  has it copied to each of its VENUE days (a three-day event with
--  capacity 10 gets 10 on each venue day). ONLINE days stay null, and an
--  event without a capacity leaves its days unlimited. An event capacity
--  outside 1 to 100,000 (stored before that limit existed) would break the
--  CHECK and is not copied; the check SQL lists those events.
--
--  "Event"."capacity" is kept, untouched, and deprecated: the code stops
--  reading it. scripts/sql/day-capacity-check.sql lists what to look at
--  after this runs (multi-venue events, days already over the copied
--  number).
-- ─────────────────────────────────────────

-- AlterTable
ALTER TABLE "EventDay" ADD COLUMN "capacity" INTEGER;

-- 1 to 100,000 (event-capacity.util.ts's MAX_VENUE_CAPACITY), and never
-- on an ONLINE day. A null locationType reads as VENUE.
ALTER TABLE "EventDay" ADD CONSTRAINT "EventDay_capacity_check"
  CHECK (
    "capacity" IS NULL
    OR ("capacity" BETWEEN 1 AND 100000 AND "locationType" IS DISTINCT FROM 'ONLINE')
  );

-- Backfill. One statement (tests/event-day/day-capacity-backfill.test.ts
-- runs it scoped to its own events by appending to this WHERE).
UPDATE "EventDay" d
SET "capacity" = e."capacity"
FROM "Event" e
WHERE d."eventId" = e."id"
  AND e."capacity" IS NOT NULL
  AND e."capacity" BETWEEN 1 AND 100000
  AND d."locationType" IS DISTINCT FROM 'ONLINE';
