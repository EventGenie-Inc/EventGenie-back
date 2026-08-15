import prisma from '../../shared/prisma/prisma.client.js';
export const tenantRepository = {
    findAll: () => prisma.tenant.findMany({
        where: { isArchived: false },
        orderBy: { createdAt: 'desc' },
    }),
    findById: (id) => prisma.tenant.findFirst({
        where: { id, isArchived: false },
    }),
    findBySlug: (slug) => prisma.tenant.findFirst({
        where: { slug, isArchived: false },
    }),
    suspend: (id) => prisma.tenant.update({
        where: { id },
        data: { subscriptionStatus: 'SUSPENDED' },
    }),
    reactivate: (id) => prisma.tenant.update({
        where: { id },
        data: { subscriptionStatus: 'ACTIVE' },
    }),
    findAllUsersByTenant: (tenantId) => prisma.user.findMany({
        where: { tenantId, isArchived: false },
    }),
};
//# sourceMappingURL=tenant.repository.js.map