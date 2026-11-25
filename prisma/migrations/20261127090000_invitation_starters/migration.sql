-- ─────────────────────────────────────────
--  STARTER DESIGNS (EG-64 Round 2). Additive only: no existing row changes.
--
--  1. InvitationStarter: a CANVAS design the super admin makes and
--     publishes, for organisers to start from (DRAFT, PUBLISHED, RETIRED).
--     Its design columns are a CANVAS design's, null while a draft is
--     unfinished; a PUBLISHED one has them all.
--  2. StoredFile gains two kinds, STARTER_ASSET (an image in a starter) and
--     STARTER_RENDER (its preview), and starterId, the starter a file
--     belongs to. They are the platform's: held by the internal e-velope
--     organisation, in <env>/platform/starters/<starterId>/…, never an
--     event's.
-- ─────────────────────────────────────────

-- CreateEnum
CREATE TYPE "InvitationStarterCategory" AS ENUM ('WEDDING', 'BIRTHDAY', 'KIDS_PARTY', 'GRADUATION', 'BABY_SHOWER', 'CORPORATE', 'NETWORKING', 'RELIGIOUS', 'YEAR_END', 'OTHER');

-- CreateEnum
CREATE TYPE "InvitationStarterStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- AlterEnum
ALTER TYPE "StoredFileKind" ADD VALUE 'STARTER_ASSET';
ALTER TYPE "StoredFileKind" ADD VALUE 'STARTER_RENDER';

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "starterId" TEXT;

-- CreateTable
CREATE TABLE "InvitationStarter" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "InvitationStarterCategory" NOT NULL,
    "format" TEXT NOT NULL,
    "document" JSONB,
    "documentVersion" INTEGER,
    "svgMarkup" TEXT,
    "hasRsvpButton" BOOLEAN,
    "previewStoredFileId" TEXT,
    "envelopeColor" TEXT,
    "sealColor" TEXT,
    "altText" TEXT,
    "status" "InvitationStarterStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationStarter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvitationStarter_status_sortOrder_idx" ON "InvitationStarter"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "StoredFile_starterId_idx" ON "StoredFile"("starterId");

-- AddForeignKey
ALTER TABLE "InvitationStarter" ADD CONSTRAINT "InvitationStarter_previewStoredFileId_fkey" FOREIGN KEY ("previewStoredFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_starterId_fkey" FOREIGN KEY ("starterId") REFERENCES "InvitationStarter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: what Prisma can't express. previewStoredFileId is never
-- required here (its foreign key sets it null if the row is ever removed,
-- and a CHECK must never block that); the service requires it to publish.
ALTER TABLE "InvitationStarter" ADD CONSTRAINT "InvitationStarter_fields_check" CHECK (
  char_length(btrim("name")) BETWEEN 1 AND 60
  AND "format" IN ('4:5', '9:16')
  AND ("documentVersion" IS NULL OR "documentVersion" > 0)
  AND ("envelopeColor" IS NULL OR "envelopeColor" ~ '^#[0-9A-Fa-f]{6}$')
  AND ("sealColor" IS NULL OR "sealColor" ~ '^#[0-9A-Fa-f]{6}$')
  -- The design is saved whole or not at all.
  AND (
    ("document" IS NULL AND "documentVersion" IS NULL AND "svgMarkup" IS NULL AND "hasRsvpButton" IS NULL)
    OR ("document" IS NOT NULL AND "documentVersion" IS NOT NULL AND "svgMarkup" IS NOT NULL AND "hasRsvpButton" IS NOT NULL)
  )
  -- Published: everything an organiser's copy needs, and when.
  AND (
    "status" <> 'PUBLISHED'
    OR ("document" IS NOT NULL AND "envelopeColor" IS NOT NULL AND "sealColor" IS NOT NULL
        AND "altText" IS NOT NULL AND "publishedAt" IS NOT NULL)
  )
);
