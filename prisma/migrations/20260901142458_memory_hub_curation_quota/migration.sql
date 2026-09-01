/*
  Warnings:

  - You are about to drop the column `isApproved` on the `MemoryItem` table. All the data in the column will be lost.
  - Added the required column `bytes` to the `MemoryItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `cloudinaryPublicId` to the `MemoryItem` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "MemoryItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "MemoryItem" DROP COLUMN "isApproved",
ADD COLUMN     "bytes" INTEGER NOT NULL,
ADD COLUMN     "cloudinaryPublicId" TEXT NOT NULL,
ADD COLUMN     "status" "MemoryItemStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "SubscriptionTierConfig" ADD COLUMN     "maxMemoryHubBytesPerEvent" INTEGER;
