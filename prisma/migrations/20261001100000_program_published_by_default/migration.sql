-- Programs are visible to guests by default.
--
-- Until now every program was created with isPublished = false (both the
-- wizard and POST /api/events/:eventId/program), and the organiser UI never
-- offered a way to change it — so no existing program was ever deliberately
-- hidden; guests simply never saw any of them. This makes every existing,
-- non-archived program visible, and makes true the column default.
-- isPublished itself stays: an organiser can still hide a program.
--
-- Safe to run once on live data: it only flips false -> true on
-- non-archived rows. Archived programs are left exactly as they are.

-- AlterTable
ALTER TABLE "EventProgram" ALTER COLUMN "isPublished" SET DEFAULT true;

-- Data migration
DO $$
DECLARE programs_published integer;
BEGIN
  UPDATE "EventProgram" SET "isPublished" = true
  WHERE "isArchived" = false AND "isPublished" = false;
  GET DIAGNOSTICS programs_published = ROW_COUNT;
  RAISE NOTICE 'program_published_by_default: % program(s) made visible to guests', programs_published;
END $$;
