import { type SmsSendSource } from '@prisma/client';
export declare const smsSendLogRepository: {
    create: (tenantId: string, eventId: string, inviteId: string, source: SmsSendSource) => import("@prisma/client").Prisma.Prisma__SmsSendLogClient<{
        id: string;
        tenantId: string;
        inviteId: string;
        sentAt: Date;
        eventId: string | null;
        source: import("@prisma/client").$Enums.SmsSendSource;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    countForTenantThisMonth: (tenantId: string) => import("@prisma/client").Prisma.PrismaPromise<number>;
    countBundleUsedForEvent: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<number>;
};
//# sourceMappingURL=sms-send-log.repository.d.ts.map