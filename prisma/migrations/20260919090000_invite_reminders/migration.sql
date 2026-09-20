-- Invite reminders: a cooldown marker on Invite plus an append-only log of
-- every reminder attempt. Purely additive — one nullable column and one new
-- table — so it is safe against the running app and existing rows.
--
-- Written idempotently (IF NOT EXISTS / guarded constraints) on purpose: the
-- shared dev database currently carries an unresolved failed migration
-- (20260917155657_add_vendor_category_and_service_price_fields) that makes
-- `prisma migrate deploy` refuse to run, so this SQL was first applied with
-- `prisma db execute`. Being idempotent, it is still safe for `migrate
-- deploy` to run it later once that record is resolved.

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN IF NOT EXISTS "lastRemindedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InviteReminderLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "deliveryMethod" "DeliveryMethod" NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "sentBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InviteReminderLog_inviteId_createdAt_idx" ON "InviteReminderLog"("inviteId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InviteReminderLog_eventId_createdAt_idx" ON "InviteReminderLog"("eventId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "InviteReminderLog" ADD CONSTRAINT "InviteReminderLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "InviteReminderLog" ADD CONSTRAINT "InviteReminderLog_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "InviteReminderLog" ADD CONSTRAINT "InviteReminderLog_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
