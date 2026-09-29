-- CreateEnum
CREATE TYPE "InvitationDesignKind" AS ENUM ('TEMPLATE', 'UPLOAD');

-- CreateTable
CREATE TABLE "InvitationDesign" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "InvitationDesignKind" NOT NULL,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "overrides" JSONB,
    "imageUrl" TEXT,
    "cloudinaryPublicId" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "altText" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "InvitationDesign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvitationDesign_eventId_idx" ON "InvitationDesign"("eventId");

-- AddForeignKey
ALTER TABLE "InvitationDesign" ADD CONSTRAINT "InvitationDesign_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────
--  Hand-written below this line: Prisma's schema language cannot express
--  either constraint. Verified before writing: `prisma migrate diff` from a
--  database carrying both back to schema.prisma is EMPTY, so a later
--  `migrate dev` will not propose dropping them.
-- ─────────────────────────────────────────

-- At most one ACTIVE design per event. Archived rows are exempt, so a
-- future design engine can keep history without a schema change.
CREATE UNIQUE INDEX "InvitationDesign_eventId_active_key" ON "InvitationDesign"("eventId") WHERE "isArchived" = false;

-- The columns must match the kind: a TEMPLATE row carries only template
-- fields, an UPLOAD row only upload fields. Backstop for the service's own
-- validation: a switch that forgot to null the other kind's columns fails
-- here instead of storing a half-template, half-upload row.
ALTER TABLE "InvitationDesign" ADD CONSTRAINT "InvitationDesign_kind_fields_check" CHECK (
  (
    "kind" = 'TEMPLATE'
    AND "templateId" IS NOT NULL
    AND "templateVersion" IS NOT NULL AND "templateVersion" > 0
    AND "overrides" IS NOT NULL
    AND "imageUrl" IS NULL AND "cloudinaryPublicId" IS NULL
    AND "width" IS NULL AND "height" IS NULL AND "altText" IS NULL
  )
  OR
  (
    "kind" = 'UPLOAD'
    AND "imageUrl" IS NOT NULL AND "cloudinaryPublicId" IS NOT NULL
    AND "width" IS NOT NULL AND "width" > 0
    AND "height" IS NOT NULL AND "height" > 0
    AND "templateId" IS NULL AND "templateVersion" IS NULL AND "overrides" IS NULL
  )
);
