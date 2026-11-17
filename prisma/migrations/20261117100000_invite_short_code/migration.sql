-- ─────────────────────────────────────────
--  INVITE SHORT CODES — the code in a text message's short link
--  (<FRONTEND_BASE_URL>/r/<code>). Additive only: one nullable column and
--  its unique index. Nothing is backfilled; a code is created the first
--  time a text needs one.
-- ─────────────────────────────────────────

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN "shortCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invite_shortCode_key" ON "Invite"("shortCode");
