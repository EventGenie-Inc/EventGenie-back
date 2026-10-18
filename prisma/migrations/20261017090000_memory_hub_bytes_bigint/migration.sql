-- A plan's Memory Hub limit can be above 2 GB: an integer column stops at
-- 2,147,483,647 bytes. Widening int4 to bigint keeps every stored value
-- (null still means unlimited), so no per-tier UPDATE is needed.
ALTER TABLE "SubscriptionTierConfig" ALTER COLUMN "maxMemoryHubBytesPerEvent" SET DATA TYPE BIGINT;
