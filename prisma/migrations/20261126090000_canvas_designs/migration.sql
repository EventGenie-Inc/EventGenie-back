-- ─────────────────────────────────────────
--  CANVAS INVITATION DESIGNS (EG-64, Round 1). Additive only: no existing
--  row is changed, and TEMPLATE and UPLOAD designs stay exactly as they are.
--
--  1. InvitationDesign gains a third kind, CANVAS (the organiser's own
--     design, made in the browser's editor), with its own columns: the
--     design document, its version, its format, the cleaned SVG guests see,
--     the rendered card's StoredFile, the envelope and seal colours and
--     whether it has an RSVP button. altText is shared with UPLOAD.
--  2. The kind CHECK is replaced by one that also knows CANVAS: each kind
--     carries only its own columns. TEMPLATE and UPLOAD keep their rules and
--     must have the new columns empty (true of every existing row).
--  3. StoredFile gains two kinds: DESIGN_ASSET (an image placed inside a
--     design) and DESIGN_RENDER (the rendered card).
--  4. A plan setting, invitationDesignsEnabled, on every standard tier and
--     custom tier: on for Elevate only (an Event Pass resolves to a standard
--     tier's settings, so a Large pass has it), off for Spark, Celebrate and
--     every custom tier, set per tier as STEERING "Tier enforcement" asks.
--
--  The new enum values are compared as text in the CHECK ("kind"::text),
--  so the constraint never casts a literal to a value added in this same
--  migration (Postgres refuses an enum value used in the transaction that
--  added it).
-- ─────────────────────────────────────────

-- AlterEnum
ALTER TYPE "InvitationDesignKind" ADD VALUE 'CANVAS';

-- AlterEnum
ALTER TYPE "StoredFileKind" ADD VALUE 'DESIGN_ASSET';
ALTER TYPE "StoredFileKind" ADD VALUE 'DESIGN_RENDER';

-- AlterTable
ALTER TABLE "InvitationDesign" ADD COLUMN     "document" JSONB,
ADD COLUMN     "documentVersion" INTEGER,
ADD COLUMN     "envelopeColor" TEXT,
ADD COLUMN     "format" TEXT,
ADD COLUMN     "hasRsvpButton" BOOLEAN,
ADD COLUMN     "pngStoredFileId" TEXT,
ADD COLUMN     "sealColor" TEXT,
ADD COLUMN     "svgMarkup" TEXT;

-- AddForeignKey
ALTER TABLE "InvitationDesign" ADD CONSTRAINT "InvitationDesign_pngStoredFileId_fkey" FOREIGN KEY ("pngStoredFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: the columns must match the kind (see
-- 20260929120000_invitation_design). pngStoredFileId is not required, as
-- an UPLOAD's storedFileId isn't: the foreign key sets it null if its
-- StoredFile row is ever removed (a tenant's deletion), and a CHECK must
-- never block that.
ALTER TABLE "InvitationDesign" DROP CONSTRAINT "InvitationDesign_kind_fields_check";

ALTER TABLE "InvitationDesign" ADD CONSTRAINT "InvitationDesign_kind_fields_check" CHECK (
  (
    "kind"::text = 'TEMPLATE'
    AND "templateId" IS NOT NULL
    AND "templateVersion" IS NOT NULL AND "templateVersion" > 0
    AND "overrides" IS NOT NULL
    AND "imageUrl" IS NULL AND "cloudinaryPublicId" IS NULL
    AND "width" IS NULL AND "height" IS NULL AND "altText" IS NULL
    AND "document" IS NULL AND "documentVersion" IS NULL AND "format" IS NULL
    AND "svgMarkup" IS NULL AND "pngStoredFileId" IS NULL
    AND "envelopeColor" IS NULL AND "sealColor" IS NULL AND "hasRsvpButton" IS NULL
  )
  OR
  (
    "kind"::text = 'UPLOAD'
    AND "imageUrl" IS NOT NULL AND "cloudinaryPublicId" IS NOT NULL
    AND "width" IS NOT NULL AND "width" > 0
    AND "height" IS NOT NULL AND "height" > 0
    AND "templateId" IS NULL AND "templateVersion" IS NULL AND "overrides" IS NULL
    AND "document" IS NULL AND "documentVersion" IS NULL AND "format" IS NULL
    AND "svgMarkup" IS NULL AND "pngStoredFileId" IS NULL
    AND "envelopeColor" IS NULL AND "sealColor" IS NULL AND "hasRsvpButton" IS NULL
  )
  OR
  (
    "kind"::text = 'CANVAS'
    AND "document" IS NOT NULL
    AND "documentVersion" IS NOT NULL AND "documentVersion" > 0
    AND "format" IN ('4:5', '9:16')
    AND "svgMarkup" IS NOT NULL
    AND "envelopeColor" ~ '^#[0-9A-Fa-f]{6}$'
    AND "sealColor" ~ '^#[0-9A-Fa-f]{6}$'
    AND "altText" IS NOT NULL
    AND "hasRsvpButton" IS NOT NULL
    AND "templateId" IS NULL AND "templateVersion" IS NULL AND "overrides" IS NULL
    AND "imageUrl" IS NULL AND "cloudinaryPublicId" IS NULL AND "storedFileId" IS NULL
    AND "width" IS NULL AND "height" IS NULL
  )
);

-- Plan setting: Elevate only.
ALTER TABLE "SubscriptionTierConfig" ADD COLUMN "invitationDesignsEnabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "SubscriptionTierConfig" SET "invitationDesignsEnabled" = false WHERE "tier" = 'SPARK';
UPDATE "SubscriptionTierConfig" SET "invitationDesignsEnabled" = false WHERE "tier" = 'CELEBRATE';
UPDATE "SubscriptionTierConfig" SET "invitationDesignsEnabled" = true WHERE "tier" = 'ELEVATE';

ALTER TABLE "CustomTier" ADD COLUMN "invitationDesignsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Every custom tier, the Free trial ('custom_free_trial') included: off
-- until a super admin switches it on.
UPDATE "CustomTier" SET "invitationDesignsEnabled" = false;
