import prisma from '../../shared/prisma/prisma.client.js';

export const tenantRepository = {

  findAll: () =>
    prisma.tenant.findMany({
      where: { isArchived: false },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string) =>
    prisma.tenant.findFirst({
      where: { id, isArchived: false },
    }),

  findBySlug: (slug: string) =>
    prisma.tenant.findFirst({
      where: { slug, isArchived: false },
    }),

  suspend: (id: string) =>
    prisma.tenant.update({
      where: { id },
      data: { subscriptionStatus: 'SUSPENDED' },
    }),

  reactivate: (id: string) =>
    prisma.tenant.update({
      where: { id },
      data: { subscriptionStatus: 'ACTIVE' },
    }),

  findAllUsersByTenant: (tenantId: string) =>
    prisma.user.findMany({
      where: { tenantId, isArchived: false },
    }),
};