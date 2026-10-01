-- The venue moves from Event to EventDay (every day has its own venue).
--
-- 1. EventDay gains location/address/latitude/longitude, all NULLABLE so
--    this cannot fail on old events that have no venue to copy. The API,
--    not the database, requires location and address from now on.
-- 2. Event.location becomes nullable: event create/update no longer take
--    a venue at all. The four Event venue columns are otherwise KEPT,
--    untouched, for the frontend deployed before this change; a later
--    migration drops them (STEERING Known gaps).
-- 3. Data: every day (archived ones included, so a restored day still has
--    its venue) of an event that HAS a venue gets a copy of it. Blank text
--    is treated as no value. Only days whose four venue columns are all
--    still NULL are touched, so the copy can never overwrite a venue an
--    organiser set, and running the UPDATE a second time changes nothing.
--    Counts are reported with RAISE NOTICE (visible when run with psql;
--    `prisma migrate deploy` does not print notices — see the report for
--    the equivalent read-only preview queries).

-- AlterTable
ALTER TABLE "EventDay" ADD COLUMN     "address" TEXT,
ADD COLUMN     "latitude" DECIMAL(10,7),
ADD COLUMN     "location" TEXT,
ADD COLUMN     "longitude" DECIMAL(10,7);

-- AlterTable
ALTER TABLE "Event" ALTER COLUMN "location" DROP NOT NULL;

-- Data migration
DO $$
DECLARE
  days_filled integer;
  events_without_venue integer;
  days_of_events_without_venue integer;
BEGIN
  UPDATE "EventDay" AS d
  SET
    "location"  = NULLIF(btrim(e."location"), ''),
    "address"   = NULLIF(btrim(e."address"), ''),
    "latitude"  = e."latitude",
    "longitude" = e."longitude"
  FROM "Event" AS e
  WHERE d."eventId" = e."id"
    AND d."location" IS NULL
    AND d."address" IS NULL
    AND d."latitude" IS NULL
    AND d."longitude" IS NULL
    AND (
      NULLIF(btrim(e."location"), '') IS NOT NULL
      OR NULLIF(btrim(e."address"), '') IS NOT NULL
      OR e."latitude" IS NOT NULL
    );
  GET DIAGNOSTICS days_filled = ROW_COUNT;

  SELECT count(*) INTO events_without_venue
  FROM "Event" AS e
  WHERE NULLIF(btrim(e."location"), '') IS NULL
    AND NULLIF(btrim(e."address"), '') IS NULL
    AND e."latitude" IS NULL;

  SELECT count(*) INTO days_of_events_without_venue
  FROM "EventDay" AS d
  JOIN "Event" AS e ON e."id" = d."eventId"
  WHERE NULLIF(btrim(e."location"), '') IS NULL
    AND NULLIF(btrim(e."address"), '') IS NULL
    AND e."latitude" IS NULL;

  RAISE NOTICE 'event_day_venue: % day(s) filled from their event''s venue', days_filled;
  RAISE NOTICE 'event_day_venue: % event(s) had no venue to copy (% day(s) left without one)',
    events_without_venue, days_of_events_without_venue;
END $$;
