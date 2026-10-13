-- Free Pilot: capabilities that were tied to a tier by name in code become
-- per-tier settings a SUPER_ADMIN can switch on for any tier.
--
-- Each column defaults to false (fails closed), then every existing tier is
-- set to exactly what the code did before this migration (STEERING "Tier
-- enforcement": a new tier column needs a per-tier UPDATE):
--   SPARK      no public events, no paid ticketing, no custom RSVP questions
--   CELEBRATE  all three
--   ELEVATE    all three, plus priority placement for its vendor spaces
ALTER TABLE "SubscriptionTierConfig"
  ADD COLUMN "publicEventsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paidTicketingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "customRsvpFieldsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vendorPriorityPlacement" BOOLEAN NOT NULL DEFAULT false;

UPDATE "SubscriptionTierConfig"
  SET "publicEventsEnabled" = false, "paidTicketingEnabled" = false,
      "customRsvpFieldsEnabled" = false, "vendorPriorityPlacement" = false
  WHERE "tier" = 'SPARK';

UPDATE "SubscriptionTierConfig"
  SET "publicEventsEnabled" = true, "paidTicketingEnabled" = true,
      "customRsvpFieldsEnabled" = true, "vendorPriorityPlacement" = false
  WHERE "tier" = 'CELEBRATE';

UPDATE "SubscriptionTierConfig"
  SET "publicEventsEnabled" = true, "paidTicketingEnabled" = true,
      "customRsvpFieldsEnabled" = true, "vendorPriorityPlacement" = true
  WHERE "tier" = 'ELEVATE';
