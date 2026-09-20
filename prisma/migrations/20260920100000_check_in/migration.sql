-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "eventDayId" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedBy" TEXT NOT NULL,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckIn_eventDayId_idx" ON "CheckIn"("eventDayId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_inviteId_eventDayId_key" ON "CheckIn"("inviteId", "eventDayId");

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_eventDayId_fkey" FOREIGN KEY ("eventDayId") REFERENCES "EventDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

