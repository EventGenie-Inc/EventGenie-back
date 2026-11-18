import { type CustomTierRequestStatus, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Db = Prisma.TransactionClient | typeof prisma;

const WITH_TENANT = { tenant: { select: { id: true, name: true, email: true } } } as const;

export const customTierRequestRepository = {
  create: (data: Prisma.CustomTierRequestUncheckedCreateInput, db: Db = prisma) =>
    db.customTierRequest.create({ data, include: WITH_TENANT }),

  // The tenant's own, newest first.
  findForTenant: (tenantId: string) =>
    prisma.customTierRequest.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),

  // The super admin's list, newest first, optionally by status.
  findAll: (status: CustomTierRequestStatus | null) =>
    prisma.customTierRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      include: WITH_TENANT,
    }),

  findById: (id: string, db: Db = prisma) => db.customTierRequest.findUnique({ where: { id }, include: WITH_TENANT }),

  update: (id: string, data: Prisma.CustomTierRequestUpdateInput, db: Db = prisma) =>
    db.customTierRequest.update({ where: { id }, data, include: WITH_TENANT }),
};
