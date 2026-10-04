-- Drops the four retired Event venue columns (STEERING "Venue" and Known
-- gaps). The venue has belonged to each EventDay since
-- 20261001090000_event_day_venue, which copied every event's venue onto
-- its days. Nothing in the backend reads or writes these columns, and the
-- current frontend reads none of them. The compatibility keys
-- `event.location`/`address`/`latitude`/`longitude` on /rsvp/validate and
-- the public event view stay: they are filled from the first day's venue,
-- never from these columns.
--
-- Irreversible: the values are gone once this runs. Every one was copied
-- onto the event's days by the earlier migration (days that already had
-- their own venue kept theirs).

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "address",
DROP COLUMN "latitude",
DROP COLUMN "location",
DROP COLUMN "longitude";
