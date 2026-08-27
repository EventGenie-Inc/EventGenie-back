export declare const smsSendLogRepository: {
    create: (tenantId: string, inviteId: string) => import("@prisma/client").Prisma.Prisma__SmsSendLogClient<{
        id: string;
        tenantId: string;
        inviteId: string;
        sentAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    countForTenantThisMonth: (tenantId: string) => import("@prisma/client").Prisma.PrismaPromise<number>;
};
//# sourceMappingURL=sms-send-log.repository.d.ts.map