import prisma from '../../shared/prisma/prisma.client.js';

// Internal accounting table only — no service/router in this phase, it
// exists purely to back assertSmsSendable's monthly quota count.
export const smsSendLogRepository = {
  create: (tenantId: string, inviteId: string) =>
    prisma.smsSendLog.create({ data: { tenantId, inviteId } }),

  countForTenantThisMonth: (tenantId: string) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return prisma.smsSendLog.count({
      where: { tenantId, sentAt: { gte: startOfMonth, lt: startOfNextMonth } },
    });
  },
};
