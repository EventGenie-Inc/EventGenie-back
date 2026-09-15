-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Event_shareToken_key" ON "Event"("shareToken");
