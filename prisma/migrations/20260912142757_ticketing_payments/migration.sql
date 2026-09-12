-- CreateEnum
CREATE TYPE "TicketPurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "ticketsRefundable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "heldCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TicketPurchase" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "status" "TicketPurchaseStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "TicketPurchase_paymentRef_key" ON "TicketPurchase"("paymentRef");

-- CreateIndex
CREATE INDEX "TicketPurchase_ticketId_status_idx" ON "TicketPurchase"("ticketId", "status");

