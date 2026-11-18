import crypto from 'crypto';
import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Db = Prisma.TransactionClient | typeof prisma;

const GRANT_INCLUDE = {
  sourceEvent: { select: { id: true, name: true } },
  grantedCustomTier: { select: { id: true, name: true } },
  recipients: {
    orderBy: { createdAt: 'asc' },
    include: { tenant: { select: { name: true } } },
  },
} as const satisfies Prisma.EventGrantInclude;

export const eventGrantRepository = {
  findInternalTenant: () =>
    prisma.tenant.findFirst({ where: { isInternal: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }),

  // A template: one of the internal organisation's events (archived too, so
  // a grant's template stays readable).
  findTemplate: (eventId: string, internalTenantId: string) =>
    prisma.event.findFirst({
      where: { id: eventId, tenantId: internalTenantId },
      select: {
        id: true,
        name: true,
        ticketing: true,
        eventDays: { where: { isArchived: false }, orderBy: { date: 'asc' }, take: 1, select: { date: true } },
      },
    }),

  createGrant: (data: Prisma.EventGrantUncheckedCreateInput) => prisma.eventGrant.create({ data, select: { id: true } }),

  findGrant: (id: string) => prisma.eventGrant.findUnique({ where: { id }, include: GRANT_INCLUDE }),

  findGrants: () => prisma.eventGrant.findMany({ orderBy: { createdAt: 'desc' }, include: GRANT_INCLUDE }),

  // Grants to every tenant (sign-ups included); the sweep delivers them.
  findAllTenantGrants: () =>
    prisma.eventGrant.findMany({ where: { toAllTenants: true, allTenantsUntil: { not: null } }, orderBy: { createdAt: 'asc' } }),

  // Tenants that should have an all-tenant grant and have no delivery row
  // for it yet: created before its date, not internal, not archived.
  findTenantsAwaiting: (grantId: string, until: Date, limit: number, tenantIds?: string[]) =>
    prisma.tenant.findMany({
      where: {
        createdAt: { lt: until },
        isInternal: false,
        isArchived: false,
        eventGrantRecipients: { none: { grantId } },
        ...(tenantIds && { id: { in: tenantIds } }),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    }),

  // Deliveries a crash left PENDING (claimed longer ago than the lease).
  findStalePending: (staleBefore: Date, limit: number, tenantIds?: string[]) =>
    prisma.eventGrantRecipient.findMany({
      where: { status: 'PENDING', claimedAt: { lt: staleBefore }, ...(tenantIds && { tenantId: { in: tenantIds } }) },
      take: limit,
      select: { grantId: true, tenantId: true },
    }),

  findTenants: (ids: string[]) =>
    prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, isInternal: true } }),

  findRecipientTenant: (tenantId: string) =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, email: true, isInternal: true, isArchived: true } }),

  // Who the copy is made by: the organisation's first active tenant admin.
  findTenantAdmin: (tenantId: string) =>
    prisma.user.findFirst({
      where: { tenantId, role: 'TENANT_ADMIN', isActive: true, isArchived: false },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }),

  // THE CLAIM — one delivery per grant and tenant (unique). A new row is
  // claimed PENDING; an existing one only when FAILED and `retryFailed` (a
  // super admin choosing the tenant again), or PENDING and older than the
  // lease (a crash). A DELIVERED one is never claimed: a tenant gets a given
  // grant once. Returns the row's id when claimed.
  claim: async (grantId: string, tenantId: string, now: Date, staleBefore: Date, retryFailed: boolean): Promise<string | null> => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "EventGrantRecipient" ("id", "grantId", "tenantId", "status", "claimedAt", "createdAt", "updatedAt")
      VALUES (${crypto.randomUUID()}, ${grantId}, ${tenantId}, 'PENDING', ${now}, ${now}, ${now})
      ON CONFLICT ("grantId", "tenantId") DO UPDATE
        SET "status" = 'PENDING', "claimedAt" = EXCLUDED."claimedAt", "failureReason" = NULL, "updatedAt" = EXCLUDED."updatedAt"
        WHERE ("EventGrantRecipient"."status" = 'FAILED' AND ${retryFailed})
           OR ("EventGrantRecipient"."status" = 'PENDING' AND "EventGrantRecipient"."claimedAt" < ${staleBefore})
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  },

  markDelivered: (tx: Prisma.TransactionClient, recipientId: string, eventId: string, now: Date) =>
    tx.eventGrantRecipient.update({ where: { id: recipientId }, data: { status: 'DELIVERED', eventId, deliveredAt: now, failureReason: null } }),

  markFailed: (recipientId: string, reason: string, db: Db = prisma) =>
    db.eventGrantRecipient.update({ where: { id: recipientId }, data: { status: 'FAILED', failureReason: reason.slice(0, 500) } }),
};
