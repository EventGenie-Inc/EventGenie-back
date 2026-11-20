-- Additive only. A delivered granted copy's caveat for the super admin: its
-- host name couldn't be the receiving organisation's name (blank, or longer
-- than a host name may be), so the copy has none yet (STEERING "Custom
-- tiers", granted events). Null for every existing row.
ALTER TABLE "EventGrantRecipient" ADD COLUMN "notice" TEXT;
