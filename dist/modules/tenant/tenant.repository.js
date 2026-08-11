import prisma from '../../shared/prisma/prisma.client.js';
import {} from './tenant.types.js';
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
    create: (data) => prisma.tenant.create({
        data: {
            name: data.name,
            slug: data.slug,
            email: data.email,
            subscriptionTier: data.subscriptionTier ?? 'SPARK',
            subscriptionStatus: 'ACTIVE',
            isArchived: false,
        },
    }),
    update: (id, data) => prisma.tenant.update({
        where: { id },
        data: { ...data, updatedAt: new Date() },
    }),
    archive: (id) => prisma.tenant.update({
        where: { id },
        data: { isArchived: true },
    }),
};
//# sourceMappingURL=tenant.repository.js.map