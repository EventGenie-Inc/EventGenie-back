-- Event.invitationTemplate / Event.invitationConfig predate InvitationDesign
-- (20260929120000_invitation_design), which replaces them. Nothing in the
-- backend or the live frontend reads or writes either column any more.
-- Irreversible: any value still in them is discarded.
ALTER TABLE "Event" DROP COLUMN "invitationConfig",
DROP COLUMN "invitationTemplate";
