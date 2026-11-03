-- Online events: an event day can happen online instead of at a venue
-- (src/modules/event-day/event-day-venue.util.ts).
--
-- Additive only: a new enum and two nullable columns on EventDay.
-- locationType defaults to VENUE, so every existing day reads as the
-- physical venue it already is (Postgres fills existing rows with the
-- default without rewriting the table); null is also read as VENUE.
-- onlineUrl is an optional https link for an ONLINE day. Nothing existing
-- is renamed, dropped or changed.

-- CreateEnum
CREATE TYPE "EventDayLocationType" AS ENUM ('VENUE', 'ONLINE');

-- AlterTable
ALTER TABLE "EventDay" ADD COLUMN     "locationType" "EventDayLocationType" DEFAULT 'VENUE',
ADD COLUMN     "onlineUrl" TEXT;

