-- Terms of Service acceptance (src/modules/terms/).
--
-- TermsAcceptance is APPEND-ONLY (schema.prisma): one row per user per
-- Terms version they accepted. A user may use the app only with a row for
-- the current TERMS_VERSION, so every existing user is asked on their next
-- visit, and bumping the version asks everyone again. A refusal is not
-- stored.
--
-- Schema only, no data: the table starts empty, so nobody has accepted yet.
--
-- Beyond what Prisma can express (added by hand at the end): a trigger
-- refusing any UPDATE, so an acceptance can't be rewritten even by a query
-- outside terms.repository.ts. DELETE is left to the foreign key's ON
-- DELETE CASCADE, which only a hard-deleted test fixture ever triggers.

-- CreateTable
CREATE TABLE "TermsAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TermsAcceptance_userId_version_key" ON "TermsAcceptance"("userId", "version");

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Never updated: a newer version is a new row.
CREATE FUNCTION "TermsAcceptance_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TermsAcceptance is append-only: record a new acceptance instead of updating one';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TermsAcceptance_no_update"
  BEFORE UPDATE ON "TermsAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "TermsAcceptance_refuse_update"();
