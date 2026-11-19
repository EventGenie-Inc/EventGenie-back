import prisma from '../../shared/prisma/prisma.client.js';

export const tenantRepository = {

  // The super admin's tenant list. Never the internal e-velope organisation
  // (it holds event templates, not a customer: reached through
  // /api/admin/event-templates/organisation instead).
  findAll: () =>
    prisma.tenant.findMany({
      where: { isArchived: false, isInternal: false },
      orderBy: { createdAt: 'desc' },
      // The super admin's list shows each tenant's custom tier by name.
      include: { customTier: { select: { id: true, name: true, description: true } } },
    }),

  findById: (id: string, includeArchived = false) =>
    prisma.tenant.findFirst({
      where: {
        id,
        ...(includeArchived ? {} : { isArchived: false }),
      },
    }),

  // The internal e-velope organisation, where event templates live (made by
  // the custom tiers migration). null on a database without it.
  findInternal: () =>
    prisma.tenant.findFirst({ where: { isInternal: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }),

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

  findAllUsersByTenant: (tenantId: string, includeArchived = false) =>
    prisma.user.findMany({
      where: {
        tenantId,
        ...(includeArchived ? {} : { isArchived: false }),
      },
    }),
};