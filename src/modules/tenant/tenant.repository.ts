import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateTenantDto, type UpdateTenantDto } from './tenant.types.js';

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

  create: (data: CreateTenantDto) =>
    prisma.tenant.create({
      data: {
        name: data.name,
        slug: data.slug,
        email: data.email,
        subscriptionTier: data.subscriptionTier ?? 'SPARK',
        subscriptionStatus: 'ACTIVE',
        isArchived: false,
      },
    }),

  update: (id: string, data: UpdateTenantDto) =>
    prisma.tenant.update({
      where: { id },
      data: { ...data, updatedAt: new Date() },
    }),

  archive: (id: string) =>
    prisma.tenant.update({
      where: { id },
      data: { isArchived: true },
    }),
};