-- ─────────────────────────────────────────
--  CUSTOM TIERS — a super admin's own tiers beside Spark, Celebrate and
--  Elevate (CustomTier), tenants assigned to one (Tenant.customTier*),
--  tenants' requests for one (CustomTierRequest), events granted from a
--  template (EventGrant, EventGrantRecipient, Event.eventGrantId and its
--  granted plan), and the super admin audit log (AdminAuditEntry).
--
--  Additive only: new tables, new nullable columns (isInternal defaults to
--  false), two CHECKs on new columns, and two new rows: the first custom
--  tier, "Free trial", with Celebrate's settings as they are now (the seed's
--  Celebrate values where this database has no Celebrate row), and the
--  internal e-velope organisation that holds event templates. No existing
--  row is changed: every tenant stays on its tier.
-- ─────────────────────────────────────────

-- CreateEnum
CREATE TYPE "CustomTierRequestStatus" AS ENUM ('NEW', 'IN_DISCUSSION', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "EventGrantDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "customTierAssignedAt" TIMESTAMP(3),
ADD COLUMN     "customTierEndingNoticeSentAt" TIMESTAMP(3),
ADD COLUMN     "customTierEndsAt" TIMESTAMP(3),
ADD COLUMN     "customTierId" TEXT,
ADD COLUMN     "isInternal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "eventGrantId" TEXT,
ADD COLUMN     "grantedCustomTierId" TEXT,
ADD COLUMN     "grantedTier" "SubscriptionTier";

-- CreateTable
CREATE TABLE "CustomTier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "maxEvents" INTEGER,
    "maxGuestsPerEvent" INTEGER,
    "maxSmsPerMonth" INTEGER,
    "maxVendorSpaces" INTEGER,
    "maxMemoryHubBytesPerEvent" BIGINT,
    "maxDocumentBytesPerEvent" BIGINT,
    "maxDocumentBytesPerFile" INTEGER,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "vendorMarketplace" BOOLEAN NOT NULL DEFAULT false,
    "memoryHubEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dragDropBuilder" BOOLEAN NOT NULL DEFAULT false,
    "guestExportEnabled" BOOLEAN NOT NULL DEFAULT false,
    "publicEventsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "paidTicketingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "customRsvpFieldsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "vendorPriorityPlacement" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomTierRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "needs" TEXT NOT NULL,
    "expectedEvents" INTEGER,
    "expectedGuests" INTEGER,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "status" "CustomTierRequestStatus" NOT NULL DEFAULT 'NEW',
    "adminNote" TEXT,
    "adminNoteAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomTierRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventGrant" (
    "id" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstDate" DATE,
    "grantedTier" "SubscriptionTier",
    "grantedCustomTierId" TEXT,
    "toAllTenants" BOOLEAN NOT NULL DEFAULT false,
    "allTenantsUntil" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventGrantRecipient" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT,
    "status" "EventGrantDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventGrantRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditEntry" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "tenantId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomTier_name_key" ON "CustomTier"("name");

-- CreateIndex
CREATE INDEX "CustomTierRequest_tenantId_createdAt_idx" ON "CustomTierRequest"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomTierRequest_status_createdAt_idx" ON "CustomTierRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EventGrant_toAllTenants_allTenantsUntil_idx" ON "EventGrant"("toAllTenants", "allTenantsUntil");

-- CreateIndex
CREATE UNIQUE INDEX "EventGrantRecipient_eventId_key" ON "EventGrantRecipient"("eventId");

-- CreateIndex
CREATE INDEX "EventGrantRecipient_status_claimedAt_idx" ON "EventGrantRecipient"("status", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventGrantRecipient_grantId_tenantId_key" ON "EventGrantRecipient"("grantId", "tenantId");

-- CreateIndex
CREATE INDEX "AdminAuditEntry_tenantId_createdAt_idx" ON "AdminAuditEntry"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditEntry_createdAt_idx" ON "AdminAuditEntry"("createdAt");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_customTierId_fkey" FOREIGN KEY ("customTierId") REFERENCES "CustomTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_eventGrantId_fkey" FOREIGN KEY ("eventGrantId") REFERENCES "EventGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_grantedCustomTierId_fkey" FOREIGN KEY ("grantedCustomTierId") REFERENCES "CustomTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomTierRequest" ADD CONSTRAINT "CustomTierRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventGrant" ADD CONSTRAINT "EventGrant_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventGrant" ADD CONSTRAINT "EventGrant_grantedCustomTierId_fkey" FOREIGN KEY ("grantedCustomTierId") REFERENCES "CustomTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventGrantRecipient" ADD CONSTRAINT "EventGrantRecipient_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "EventGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventGrantRecipient" ADD CONSTRAINT "EventGrantRecipient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventGrantRecipient" ADD CONSTRAINT "EventGrantRecipient_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A grant, and a granted event, carry exactly one plan (or, for an event,
-- none): a standard tier or a custom tier, never both.
ALTER TABLE "EventGrant" ADD CONSTRAINT "EventGrant_one_plan_check"
  CHECK (("grantedTier" IS NULL) <> ("grantedCustomTierId" IS NULL));
ALTER TABLE "Event" ADD CONSTRAINT "Event_granted_plan_check"
  CHECK ("grantedTier" IS NULL OR "grantedCustomTierId" IS NULL);

-- The first custom tier: "Free trial", with Celebrate's current settings.
INSERT INTO "CustomTier" (
  "id", "name", "description",
  "maxEvents", "maxGuestsPerEvent", "maxSmsPerMonth", "maxVendorSpaces",
  "maxMemoryHubBytesPerEvent", "maxDocumentBytesPerEvent", "maxDocumentBytesPerFile",
  "emailEnabled", "smsEnabled", "vendorMarketplace", "memoryHubEnabled", "dragDropBuilder",
  "guestExportEnabled", "publicEventsEnabled", "paidTicketingEnabled", "customRsvpFieldsEnabled",
  "vendorPriorityPlacement", "isActive", "createdAt", "updatedAt"
)
SELECT
  'custom_free_trial', 'Free trial', 'For organisers trying e-velope before they buy a plan.',
  c."maxEvents", c."maxGuestsPerEvent", c."maxSmsPerMonth", c."maxVendorSpaces",
  c."maxMemoryHubBytesPerEvent", c."maxDocumentBytesPerEvent", c."maxDocumentBytesPerFile",
  c."emailEnabled", c."smsEnabled", c."vendorMarketplace", c."memoryHubEnabled", c."dragDropBuilder",
  c."guestExportEnabled", c."publicEventsEnabled", c."paidTicketingEnabled", c."customRsvpFieldsEnabled",
  c."vendorPriorityPlacement", true, now(), now()
FROM "SubscriptionTierConfig" c
WHERE c."tier" = 'CELEBRATE'
UNION ALL
-- No Celebrate row here (a database the seed never reached): the seed's
-- Celebrate values (prisma/seed.ts's TIER_CONFIGS).
SELECT
  'custom_free_trial', 'Free trial', 'For organisers trying e-velope before they buy a plan.',
  5, 300, 100, 2,
  524288000, 524288000, 5242880,
  true, true, true, true, false,
  true, true, true, true,
  false, true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "SubscriptionTierConfig" WHERE "tier" = 'CELEBRATE')
ON CONFLICT DO NOTHING;

-- The internal e-velope organisation: holds the super admin's event
-- templates, never visible to tenants. Stored on Elevate (never billed) so a
-- template can use every feature.
INSERT INTO "Tenant" ("id", "name", "slug", "email", "subscriptionTier", "subscriptionStatus", "isArchived", "isInternal", "createdAt", "updatedAt")
VALUES ('evelope_internal', 'e-velope (internal)', 'e-velope-internal', 'templates@e-velope.co.za', 'ELEVATE', 'ACTIVE', false, true, now(), now())
ON CONFLICT DO NOTHING;
