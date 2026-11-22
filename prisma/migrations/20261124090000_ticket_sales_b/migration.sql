-- Additive only. Ticket sales, Round B (STEERING "Ticket sales"): checkout,
-- confirmation, issued tickets and their check-ins.
--
-- 1. TicketOrder: a guest's order for a paid public event, every figure
--    snapshotted at checkout (the fee calculator's breakdown, the live payout
--    subaccount, the Terms version). TicketOrderItem: its ticket types.
--    TicketOrderPayment: every Paystack attempt, its reference kept forever.
-- 2. IssuedTicket: one admission, bought in a paid order; its own QR pass.
-- 3. TicketCheckIn: a ticket checked in on a day, one per ticket per day.
-- 4. CheckInPassKind gains TICKET (a ticket's QR prefix kind). Adding an
--    enum value is additive: no existing row or value changes.
-- No existing table or row is changed.

-- CreateEnum
CREATE TYPE "TicketOrderStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'UNDER_REVIEW', 'REFUNDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "TicketOrderPaymentStatus" AS ENUM ('INITIATED', 'SUCCEEDED', 'FAILED', 'DUPLICATE', 'MISMATCH');

-- CreateEnum
CREATE TYPE "IssuedTicketStatus" AS ENUM ('VALID', 'CANCELLED', 'REFUNDED', 'REVERSED');

-- AlterEnum
ALTER TYPE "CheckInPassKind" ADD VALUE 'TICKET';

-- CreateTable
CREATE TABLE "TicketOrder" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "TicketOrderStatus" NOT NULL DEFAULT 'PENDING',
    "reviewReason" TEXT,
    "buyerName" TEXT NOT NULL,
    "buyerEmail" TEXT NOT NULL,
    "buyerPhone" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "commissionCents" INTEGER NOT NULL,
    "platformFixedFeeCents" INTEGER NOT NULL,
    "processingFeeCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "transactionChargeCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "subaccountCode" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "holdExpiresAt" TIMESTAMP(3) NOT NULL,
    "holdReleasedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paidReference" TEXT,
    "paystackTransactionId" TEXT,
    "actualFeeCents" INTEGER,
    "oversold" BOOLEAN NOT NULL DEFAULT false,
    "disputeStatus" TEXT,
    "confirmationEmailClaimedAt" TIMESTAMP(3),
    "confirmationEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "typeName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "admitsAllDays" BOOLEAN NOT NULL,
    "admittedDayIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketOrderPayment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "authorizationUrl" TEXT,
    "status" "TicketOrderPaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketOrderPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedTicket" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "indexInOrder" INTEGER NOT NULL,
    "status" "IssuedTicketStatus" NOT NULL DEFAULT 'VALID',
    "voidedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCheckIn" (
    "id" TEXT NOT NULL,
    "issuedTicketId" TEXT NOT NULL,
    "eventDayId" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedBy" TEXT NOT NULL,

    CONSTRAINT "TicketCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketOrder_eventId_status_idx" ON "TicketOrder"("eventId", "status");

-- CreateIndex
CREATE INDEX "TicketOrder_requestFingerprint_status_idx" ON "TicketOrder"("requestFingerprint", "status");

-- CreateIndex
CREATE INDEX "TicketOrder_status_holdExpiresAt_idx" ON "TicketOrder"("status", "holdExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TicketOrder_eventId_idempotencyKey_key" ON "TicketOrder"("eventId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TicketOrderItem_orderId_idx" ON "TicketOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "TicketOrderItem_ticketTypeId_idx" ON "TicketOrderItem"("ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketOrderPayment_reference_key" ON "TicketOrderPayment"("reference");

-- CreateIndex
CREATE INDEX "TicketOrderPayment_orderId_createdAt_idx" ON "TicketOrderPayment"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedTicket_number_key" ON "IssuedTicket"("number");

-- CreateIndex
CREATE INDEX "IssuedTicket_orderId_idx" ON "IssuedTicket"("orderId");

-- CreateIndex
CREATE INDEX "IssuedTicket_eventId_status_idx" ON "IssuedTicket"("eventId", "status");

-- CreateIndex
CREATE INDEX "TicketCheckIn_eventDayId_idx" ON "TicketCheckIn"("eventDayId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketCheckIn_issuedTicketId_eventDayId_key" ON "TicketCheckIn"("issuedTicketId", "eventDayId");

-- AddForeignKey
ALTER TABLE "TicketOrder" ADD CONSTRAINT "TicketOrder_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketOrderItem" ADD CONSTRAINT "TicketOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TicketOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketOrderItem" ADD CONSTRAINT "TicketOrderItem_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketOrderPayment" ADD CONSTRAINT "TicketOrderPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TicketOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TicketOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_issuedTicketId_fkey" FOREIGN KEY ("issuedTicketId") REFERENCES "IssuedTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_eventDayId_fkey" FOREIGN KEY ("eventDayId") REFERENCES "EventDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A few rules the database keeps too.
ALTER TABLE "TicketOrderItem" ADD CONSTRAINT "TicketOrderItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 20);
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_index_check" CHECK ("indexInOrder" >= 1);
ALTER TABLE "TicketOrder" ADD CONSTRAINT "TicketOrder_money_check"
  CHECK ("subtotalCents" > 0 AND "totalCents" = "subtotalCents" + "transactionChargeCents");
