-- One email, one guest per event, guaranteed by the database: a partial
-- unique index on (eventId, lower(email)) over live guests. The app already
-- refuses a duplicate on every path (organiser create, update and import,
-- RSVP, self-registration); this closes the race two of them could win
-- together. Archived guests are outside it, so archiving a duplicate frees
-- its address. Guests without an email (phone-only guests, plus-ones) are
-- outside it too.
--
-- Prisma can't express a partial or expression index, so it lives only
-- here, like InvitationDesign's and TeamInvite's.
--
-- REFUSES TO RUN while any duplicate exists. Postgres would refuse the
-- CREATE UNIQUE INDEX anyway; the check below does it first, with a message
-- that says what to do. Migrations run in a transaction, so nothing is
-- applied. List the duplicates, read-only, with
--     npx tsx scripts/report-guest-email-duplicates.ts
-- and resolve each group by hand (archive one guest, or change one email),
-- then apply this again.
DO $$
DECLARE
    duplicate_groups INTEGER;
BEGIN
    SELECT count(*) INTO duplicate_groups FROM (
        SELECT 1
        FROM "Guest"
        WHERE "isArchived" = false AND "email" IS NOT NULL
        GROUP BY "eventId", lower("email")
        HAVING count(*) > 1
    ) d;

    IF duplicate_groups > 0 THEN
        RAISE EXCEPTION
            'Guest_eventId_email_live_key: % email(s) are held by more than one live guest on the same event. Run scripts/report-guest-email-duplicates.ts, resolve them, and apply this migration again.',
            duplicate_groups;
    END IF;
END $$;

CREATE UNIQUE INDEX "Guest_eventId_email_live_key"
    ON "Guest" ("eventId", lower("email"))
    WHERE "isArchived" = false AND "email" IS NOT NULL;
