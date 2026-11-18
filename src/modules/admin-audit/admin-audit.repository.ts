import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { type AdminAuditEntryView } from './admin-audit.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const adminAuditRepository = {
  create: (
    data: { actorUserId: string; actorEmail: string; tenantId: string | null; action: string; details: Prisma.InputJsonValue },
    db: Db = prisma
  ) => db.adminAuditEntry.create({ data, select: { id: true } }),

  findActorEmail: async (userId: string, db: Db = prisma): Promise<string> =>
    (await db.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? '',

  // Newest first. `before`: entries older than this (the next page).
  list: (where: { tenantId?: string | null }, limit: number, before: Date | null): Promise<AdminAuditEntryView[]> =>
    prisma.adminAuditEntry.findMany({
      where: {
        ...(where.tenantId !== undefined && { tenantId: where.tenantId }),
        ...(before && { createdAt: { lt: before } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    }),

  // For the catch-all record: the tenant a super admin's write touched,
  // from the record in its path.
  tenantOfEvent: async (eventId: string): Promise<string | null> =>
    (await prisma.event.findUnique({ where: { id: eventId }, select: { tenantId: true } }))?.tenantId ?? null,
  tenantOfUser: async (userId: string): Promise<string | null> =>
    (await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } }))?.tenantId ?? null,
  tenantOfGuest: async (guestId: string): Promise<string | null> =>
    (await prisma.guest.findUnique({ where: { id: guestId }, select: { event: { select: { tenantId: true } } } }))?.event.tenantId ?? null,
  tenantOfVendorSpace: async (spaceId: string): Promise<string | null> =>
    (await prisma.vendorSpace.findUnique({ where: { id: spaceId }, select: { tenantId: true } }))?.tenantId ?? null,
  tenantExists: async (tenantId: string): Promise<boolean> =>
    !!(await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })),
};
