/*
  Warnings:

  - You are about to drop the column `vendorSpaceId` on the `User` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_vendorSpaceId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "vendorSpaceId";

-- CreateTable
CREATE TABLE "VendorSpaceUser" (
    "id" TEXT NOT NULL,
    "vendorSpaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "VendorSpaceUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorSpaceUser_vendorSpaceId_userId_key" ON "VendorSpaceUser"("vendorSpaceId", "userId");

-- AddForeignKey
ALTER TABLE "VendorSpaceUser" ADD CONSTRAINT "VendorSpaceUser_vendorSpaceId_fkey" FOREIGN KEY ("vendorSpaceId") REFERENCES "VendorSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorSpaceUser" ADD CONSTRAINT "VendorSpaceUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
