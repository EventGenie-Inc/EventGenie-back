-- ─────────────────────────────────────────
--  STORED FILES — one record per file in Cloudinary (storage module).
--  Additive only: two new tables, one nullable pointer column on each
--  owning table, and a backfill.
--
--  Backfill: every file a record already references gets a StoredFile row
--  marked legacy, so it is deleted through its record from now on. A row
--  that was already deleted (a purged Memory Hub item, a deleted guest
--  document) is recorded DELETED. Nothing is requested for deletion here:
--  no file is deleted by this migration, and files no record references
--  are left alone. Where two records name the same public id, the first
--  insert wins (ON CONFLICT DO NOTHING) and both owners point at it.
-- ─────────────────────────────────────────

-- CreateEnum
CREATE TYPE "StoredFileKind" AS ENUM ('COVER', 'MEMORY_ITEM', 'INVITATION_DESIGN', 'FEEDBACK_LOGO', 'GUEST_DOCUMENT');

-- CreateEnum
CREATE TYPE "StoredFileStatus" AS ENUM ('SIGNED', 'UPLOADED', 'ATTACHED', 'DELETE_REQUESTED', 'DELETED');

-- CreateEnum
CREATE TYPE "StoredFileResourceType" AS ENUM ('IMAGE', 'VIDEO', 'RAW');

-- CreateEnum
CREATE TYPE "StoredFileDeliveryType" AS ENUM ('UPLOAD', 'PRIVATE');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "coverFileId" TEXT;

-- AlterTable
ALTER TABLE "MemoryItem" ADD COLUMN     "storedFileId" TEXT;

-- AlterTable
ALTER TABLE "GuestDocument" ADD COLUMN     "storedFileId" TEXT;

-- AlterTable
ALTER TABLE "InvitationDesign" ADD COLUMN     "storedFileId" TEXT;

-- AlterTable
ALTER TABLE "EventFeedback" ADD COLUMN     "logoFileId" TEXT;

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "resourceType" "StoredFileResourceType" NOT NULL,
    "deliveryType" "StoredFileDeliveryType" NOT NULL DEFAULT 'UPLOAD',
    "kind" "StoredFileKind" NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT,
    "draftId" TEXT,
    "uploadedByUserId" TEXT,
    "uploadedByInviteId" TEXT,
    "bytes" INTEGER,
    "format" TEXT,
    "status" "StoredFileStatus" NOT NULL,
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMP(3),
    "attachedAt" TIMESTAMP(3),
    "deleteRequestedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deleteAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextDeleteAttemptAt" TIMESTAMP(3),
    "lastDeleteError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageReconciliation" (
    "id" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "requestedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "listedCount" INTEGER NOT NULL DEFAULT 0,
    "listedBytes" BIGINT NOT NULL DEFAULT 0,
    "orphanCount" INTEGER NOT NULL DEFAULT 0,
    "orphanBytes" BIGINT NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "sizeMismatchCount" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,

    CONSTRAINT "StorageReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_publicId_key" ON "StoredFile"("publicId");

-- CreateIndex
CREATE INDEX "StoredFile_status_nextDeleteAttemptAt_idx" ON "StoredFile"("status", "nextDeleteAttemptAt");

-- CreateIndex
CREATE INDEX "StoredFile_status_signedAt_idx" ON "StoredFile"("status", "signedAt");

-- CreateIndex
CREATE INDEX "StoredFile_eventId_idx" ON "StoredFile"("eventId");

-- CreateIndex
CREATE INDEX "StoredFile_draftId_idx" ON "StoredFile"("draftId");

-- CreateIndex
CREATE INDEX "StoredFile_tenantId_idx" ON "StoredFile"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageReconciliation_periodKey_key" ON "StorageReconciliation"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "GuestDocument_storedFileId_key" ON "GuestDocument"("storedFileId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_coverFileId_fkey" FOREIGN KEY ("coverFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestDocument" ADD CONSTRAINT "GuestDocument_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationDesign" ADD CONSTRAINT "InvitationDesign_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventFeedback" ADD CONSTRAINT "EventFeedback_logoFileId_fkey" FOREIGN KEY ("logoFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Backfill: legacy rows ──────────────────

-- Event covers (live and archived events alike; nothing is deleted).
INSERT INTO "StoredFile" ("id", "publicId", "resourceType", "deliveryType", "kind", "tenantId", "eventId", "status", "legacy", "signedAt", "uploadedAt", "attachedAt", "createdAt", "updatedAt")
SELECT 'legacy_' || replace(gen_random_uuid()::text, '-', ''), e."coverImagePublicId", 'IMAGE', 'UPLOAD', 'COVER', e."tenantId", e."id", 'ATTACHED', true, e."createdAt", e."createdAt", e."createdAt", now(), now()
FROM "Event" e
WHERE e."coverImagePublicId" IS NOT NULL
ON CONFLICT ("publicId") DO NOTHING;

-- Covers held by a wizard draft (EventDraft.payload is the frontend's JSON).
INSERT INTO "StoredFile" ("id", "publicId", "resourceType", "deliveryType", "kind", "tenantId", "draftId", "uploadedByUserId", "status", "legacy", "signedAt", "uploadedAt", "attachedAt", "createdAt", "updatedAt")
SELECT 'legacy_' || replace(gen_random_uuid()::text, '-', ''), d."payload"->>'coverImagePublicId', 'IMAGE', 'UPLOAD', 'COVER', d."tenantId", d."id", d."createdByUserId", 'ATTACHED', true, d."createdAt", d."createdAt", d."updatedAt", now(), now()
FROM "EventDraft" d
WHERE jsonb_typeof(d."payload"->'coverImagePublicId') = 'string'
ON CONFLICT ("publicId") DO NOTHING;

-- Memory Hub items. bytes is the figure the browser reported then: legacy.
INSERT INTO "StoredFile" ("id", "publicId", "resourceType", "deliveryType", "kind", "tenantId", "eventId", "uploadedByUserId", "uploadedByInviteId", "bytes", "status", "legacy", "signedAt", "uploadedAt", "attachedAt", "deletedAt", "createdAt", "updatedAt")
SELECT 'legacy_' || replace(gen_random_uuid()::text, '-', ''), m."cloudinaryPublicId",
       CASE WHEN m."mediaType" = 'VIDEO' THEN 'VIDEO'::"StoredFileResourceType" ELSE 'IMAGE'::"StoredFileResourceType" END,
       'UPLOAD', 'MEMORY_ITEM', e."tenantId", e."id", m."uploadedByUserId", NULL, m."bytes",
       CASE WHEN m."purgedAt" IS NOT NULL THEN 'DELETED'::"StoredFileStatus" ELSE 'ATTACHED'::"StoredFileStatus" END,
       true, m."createdAt", m."createdAt", m."createdAt", m."purgedAt", now(), now()
FROM "MemoryItem" m
JOIN "MemoryHub" h ON h."id" = m."memoryHubId"
JOIN "Event" e ON e."id" = h."eventId"
ON CONFLICT ("publicId") DO NOTHING;

-- Uploaded invitation designs, archived rows included.
INSERT INTO "StoredFile" ("id", "publicId", "resourceType", "deliveryType", "kind", "tenantId", "eventId", "status", "legacy", "signedAt", "uploadedAt", "attachedAt", "createdAt", "updatedAt")
SELECT 'legacy_' || replace(gen_random_uuid()::text, '-', ''), i."cloudinaryPublicId", 'IMAGE', 'UPLOAD', 'INVITATION_DESIGN', e."tenantId", e."id", 'ATTACHED', true, i."createdAt", i."createdAt", i."updatedAt", now(), now()
FROM "InvitationDesign" i
JOIN "Event" e ON e."id" = i."eventId"
WHERE i."cloudinaryPublicId" IS NOT NULL
ON CONFLICT ("publicId") DO NOTHING;

-- Feedback logos.
INSERT INTO "StoredFile" ("id", "publicId", "resourceType", "deliveryType", "kind", "tenantId", "eventId", "status", "legacy", "signedAt", "uploadedAt", "attachedAt", "createdAt", "updatedAt")
SELECT 'legacy_' || replace(gen_random_uuid()::text, '-', ''), f."logoPublicId", 'IMAGE', 'UPLOAD', 'FEEDBACK_LOGO', f."tenantId", f."eventId", 'ATTACHED', true, f."submittedAt", f."submittedAt", f."updatedAt", now(), now()
FROM "EventFeedback" f
WHERE f."logoPublicId" IS NOT NULL
ON CONFLICT ("publicId") DO NOTHING;

-- Guests' documents: private raw files, their own state carried over.
INSERT INTO "StoredFile" ("id", "publicId", "resourceType", "deliveryType", "kind", "tenantId", "eventId", "uploadedByInviteId", "bytes", "status", "legacy", "signedAt", "uploadedAt", "attachedAt", "deleteRequestedAt", "deletedAt", "lastDeleteError", "createdAt", "updatedAt")
SELECT 'legacy_' || replace(gen_random_uuid()::text, '-', ''), g."cloudinaryPublicId", 'RAW', 'PRIVATE', 'GUEST_DOCUMENT', e."tenantId", e."id",
       CASE WHEN g."source" = 'INVITE' THEN g."inviteId" ELSE NULL END, g."sizeBytes",
       CASE WHEN g."deletedAt" IS NOT NULL THEN 'DELETED'::"StoredFileStatus"
            WHEN g."deleteRequestedAt" IS NOT NULL THEN 'DELETE_REQUESTED'::"StoredFileStatus"
            WHEN g."attachedAt" IS NOT NULL THEN 'ATTACHED'::"StoredFileStatus"
            ELSE 'UPLOADED'::"StoredFileStatus" END,
       true, g."uploadedAt", g."uploadedAt", g."attachedAt", g."deleteRequestedAt", g."deletedAt", g."lastDeleteError", now(), now()
FROM "GuestDocument" g
JOIN "Event" e ON e."id" = g."eventId"
ON CONFLICT ("publicId") DO NOTHING;

-- ── Backfill: owners point at their rows ───

UPDATE "Event" e SET "coverFileId" = s."id" FROM "StoredFile" s WHERE s."publicId" = e."coverImagePublicId";
UPDATE "MemoryItem" m SET "storedFileId" = s."id" FROM "StoredFile" s WHERE s."publicId" = m."cloudinaryPublicId";
UPDATE "InvitationDesign" i SET "storedFileId" = s."id" FROM "StoredFile" s WHERE s."publicId" = i."cloudinaryPublicId";
UPDATE "EventFeedback" f SET "logoFileId" = s."id" FROM "StoredFile" s WHERE s."publicId" = f."logoPublicId";
UPDATE "GuestDocument" g SET "storedFileId" = s."id" FROM "StoredFile" s WHERE s."publicId" = g."cloudinaryPublicId";
