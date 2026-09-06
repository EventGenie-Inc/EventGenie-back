-- AlterTable
ALTER TABLE "Guest" ADD COLUMN     "hostGuestId" TEXT,
ADD COLUMN     "plusOnesAllowed" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_hostGuestId_fkey" FOREIGN KEY ("hostGuestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
