-- Backfill maxVendorSpaces and maxMemoryHubBytesPerEvent.
--
-- Both columns were added as a bare `ADD COLUMN` with no per-tier UPDATE
-- (20260831161735_vendor_space_max_vendor_spaces and
-- 20260901142458_memory_hub_curation_quota). NULL on a numeric tier limit
-- means UNLIMITED (see STEERING.md "Tier enforcement"), so on any database
-- the seed has never touched, every tier currently reads as unlimited for
-- both columns — including SPARK, which is supposed to have zero of
-- either. That is a fail-OPEN gap: a Spark tenant could create vendor
-- spaces and Memory Hub uploads the product intends to block entirely.
--
-- Intended values (confirmed against prisma/seed.ts's TIER_CONFIGS, the
-- source of truth this migration must match, not any one caller's
-- restatement of it):
--
--   maxVendorSpaces            SPARK 0   CELEBRATE 2            ELEVATE NULL (unlimited)
--   maxMemoryHubBytesPerEvent  SPARK 0   CELEBRATE 524288000    ELEVATE NULL (unlimited)
--                                        (500 * 1024 * 1024 bytes = 500MB)
--
-- Plain per-tier UPDATEs — idempotent by construction: setting a column to
-- the same value it already holds changes nothing, so running this against
-- a database the seed has already populated correctly (e.g. the current
-- dev database, verified by hand before writing this migration) is a
-- no-op.

UPDATE "SubscriptionTierConfig" SET "maxVendorSpaces" = 0 WHERE "tier" = 'SPARK';
UPDATE "SubscriptionTierConfig" SET "maxVendorSpaces" = 2 WHERE "tier" = 'CELEBRATE';
UPDATE "SubscriptionTierConfig" SET "maxVendorSpaces" = NULL WHERE "tier" = 'ELEVATE';

UPDATE "SubscriptionTierConfig" SET "maxMemoryHubBytesPerEvent" = 0 WHERE "tier" = 'SPARK';
UPDATE "SubscriptionTierConfig" SET "maxMemoryHubBytesPerEvent" = 524288000 WHERE "tier" = 'CELEBRATE';
UPDATE "SubscriptionTierConfig" SET "maxMemoryHubBytesPerEvent" = NULL WHERE "tier" = 'ELEVATE';
