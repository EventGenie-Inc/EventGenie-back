-- Trusted Devices Hardening batch, Part 6 — DeviceToken.userAgent.
--
-- Purely additive: a single nullable column with no default, on a table
-- that already exists. Existing rows get NULL (no backfill needed or
-- attempted — there is nothing to derive a past request's User-Agent
-- from retroactively), and nothing reads this column yet (a future
-- device-management screen). Dev and prod share one database, so this
-- runs against production data on deploy — confirmed safe: no table
-- lock beyond the brief one Postgres takes to add a nullable column
-- with no default (no full-table rewrite), no existing query or code
-- path references this column, and no NOT NULL constraint that could
-- fail against existing rows.

-- AlterTable
ALTER TABLE "DeviceToken" ADD COLUMN "userAgent" TEXT;
