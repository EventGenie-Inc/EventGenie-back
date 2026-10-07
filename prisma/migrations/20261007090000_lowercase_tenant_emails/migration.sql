-- Team Members follow-ups: Tenant.email is stored lowercase and trimmed
-- (shared/utils/email.util.ts's normalizeEmail), like User and Guest emails
-- (20261006091000_lowercase_emails). New writes already are; this brings
-- existing tenants in line.
--
-- Tenant.email is unique, so a tenant whose normalised email would COLLIDE
-- with another tenant's ("Acme@x.com" and "acme@x.com") is left exactly as
-- it is, never merged or overwritten: both rows are skipped (the UPDATE
-- would otherwise fail and roll back the whole migration). The Paystack
-- subscription lookup (subscription.repository.ts's findByEmail) refuses
-- to match an address two tenants share once normalised, so a skipped pair
-- gets no subscription webhook credited to either until it's resolved.
-- Run `npx tsx scripts/report-email-collisions.ts` BEFORE applying this to
-- see which rows will be skipped.

WITH normalised AS (
    SELECT "id", lower(regexp_replace("email", '^\s+|\s+$', '', 'g')) AS "norm"
    FROM "Tenant"
),
colliding AS (
    SELECT "norm" FROM normalised GROUP BY "norm" HAVING count(*) > 1
)
UPDATE "Tenant" t
SET "email" = n."norm"
FROM normalised n
WHERE t."id" = n."id"
  AND t."email" <> n."norm"
  AND n."norm" NOT IN (SELECT "norm" FROM colliding);
