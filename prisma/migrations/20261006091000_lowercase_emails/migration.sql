-- Team Members batch: emails are stored lowercase and trimmed everywhere
-- (shared/utils/email.util.ts's normalizeEmail). New writes already are;
-- this brings existing User and Guest rows in line.
--
-- A row whose normalised email would COLLIDE with another row's is left
-- exactly as it is, never merged or overwritten:
--   - User: email is unique platform-wide, so "A@x.com" and "a@x.com"
--     can't both become "a@x.com" (the UPDATE would fail and roll back the
--     whole migration). Both rows are skipped.
--   - Guest: there is no unique constraint, but the same email twice on
--     ONE event is a duplicate guest (guest-validation.util.ts's contact
--     check), so both rows are skipped there too. The same email on two
--     different events is not a collision.
-- Run `npx tsx scripts/report-email-collisions.ts` against the database
-- BEFORE applying this to see exactly which rows will be skipped, and
-- resolve them by hand. Running it afterwards lists the same rows (they are
-- still un-normalised), so it also confirms nothing was missed.
--
-- Trimming uses the same whitespace as JavaScript's String.prototype.trim
-- for ordinary input (spaces, tabs, line breaks): \s in a Postgres regex.

-- Users
WITH normalised AS (
    SELECT "id", lower(regexp_replace("email", '^\s+|\s+$', '', 'g')) AS "norm"
    FROM "User"
),
colliding AS (
    SELECT "norm" FROM normalised GROUP BY "norm" HAVING count(*) > 1
)
UPDATE "User" u
SET "email" = n."norm"
FROM normalised n
WHERE u."id" = n."id"
  AND u."email" <> n."norm"
  AND n."norm" NOT IN (SELECT "norm" FROM colliding);

-- Guests (archived ones included: a restored guest must match too)
WITH normalised AS (
    SELECT "id", "eventId", lower(regexp_replace("email", '^\s+|\s+$', '', 'g')) AS "norm"
    FROM "Guest"
    WHERE "email" IS NOT NULL
),
colliding AS (
    SELECT "eventId", "norm" FROM normalised GROUP BY "eventId", "norm" HAVING count(*) > 1
)
UPDATE "Guest" g
SET "email" = n."norm"
FROM normalised n
WHERE g."id" = n."id"
  AND g."email" <> n."norm"
  AND NOT EXISTS (
      SELECT 1 FROM colliding c WHERE c."eventId" = n."eventId" AND c."norm" = n."norm"
  );
