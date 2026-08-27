-- CreateTable
CREATE TABLE "SmsSendLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsSendLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsSendLog_tenantId_sentAt_idx" ON "SmsSendLog"("tenantId", "sentAt");

-- AddForeignKey
ALTER TABLE "SmsSendLog" ADD CONSTRAINT "SmsSendLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsSendLog" ADD CONSTRAINT "SmsSendLog_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
