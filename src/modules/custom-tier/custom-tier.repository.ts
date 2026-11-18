import { type CustomTier, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { type CustomTierRow } from './custom-tier.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// The BIGINT byte limits leave this file as plain numbers (see
// CustomTierRow). Read custom tiers only through this repository.
const toPlain = (row: CustomTier): CustomTierRow => ({
  ...row,
  maxMemoryHubBytesPerEvent: row.maxMemoryHubBytesPerEvent === null ? null : Number(row.maxMemoryHubBytesPerEvent),
  maxDocumentBytesPerEvent: row.maxDocumentBytesPerEvent === null ? null : Number(row.maxDocumentBytesPerEvent),
});

// The billing state the custom-tier assignment checks and resets.
const TENANT_ASSIGNMENT_FIELDS = {
  id: true,
  name: true,
  email: true,
  isInternal: true,
  customTierId: true,
  customTierEndsAt: true,
  customTierAssignedAt: true,
  subscriptionTier: true,
  subscriptionPeriod: true,
  subscriptionCurrentPeriodEnd: true,
  subscriptionCancelAtPeriodEnd: true,
  subscriptionGraceStartedAt: true,
  paystackSubscriptionCode: true,
} as const;

export const customTierRepository = {
  findAll: async (db: Db = prisma): Promise<CustomTierRow[]> =>
    (await db.customTier.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] })).map(toPlain),

  findById: async (id: string, db: Db = prisma): Promise<CustomTierRow | null> => {
    const row = await db.customTier.findUnique({ where: { id } });
    return row ? toPlain(row) : null;
  },

  // Case-insensitive: "Free trial" and "free trial" are the same name to a
  // super admin. The unique index is the race backstop.
  findByNameInsensitive: async (name: string, db: Db = prisma): Promise<CustomTierRow | null> => {
    const row = await db.customTier.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    return row ? toPlain(row) : null;
  },

  create: async (data: Prisma.CustomTierCreateInput, db: Db = prisma): Promise<CustomTierRow> =>
    toPlain(await db.customTier.create({ data })),

  update: async (id: string, data: Prisma.CustomTierUpdateInput, db: Db = prisma): Promise<CustomTierRow> =>
    toPlain(await db.customTier.update({ where: { id }, data })),

  // Tenants on each tier now: assigned and not past their end date.
  countCurrentTenantsByTier: async (now: Date, db: Db = prisma): Promise<Map<string, number>> => {
    const rows = await db.tenant.groupBy({
      by: ['customTierId'],
      where: { customTierId: { not: null }, OR: [{ customTierEndsAt: null }, { customTierEndsAt: { gt: now } }] },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.customTierId as string, r._count._all]));
  },

  findTenantForAssignment: (tenantId: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { id: tenantId }, select: TENANT_ASSIGNMENT_FIELDS }),

  // Takes the tenant's row lock, so two assignments to one tenant at once run
  // one after the other.
  lockTenant: async (tx: Prisma.TransactionClient, tenantId: string): Promise<void> => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  },

  assign: (
    tenantId: string,
    data: { customTierId: string; endsAt: Date | null; now: Date; resetBilling: boolean },
    db: Db = prisma
  ) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        customTierId: data.customTierId,
        customTierEndsAt: data.endsAt,
        customTierAssignedAt: data.now,
        // A new assignment or end date gets its own "ends in 7 days" email.
        customTierEndingNoticeSentAt: null,
        // The super admin confirmed the Paystack subscription is cancelled:
        // the billing state stops claiming one, so the tenant is on Spark
        // once the custom tier ends (or is taken off), and nothing here
        // refers to a subscription that no longer exists.
        ...(data.resetBilling && {
          subscriptionTier: 'SPARK',
          subscriptionPeriod: null,
          subscriptionCurrentPeriodEnd: null,
          subscriptionCancelAtPeriodEnd: false,
          subscriptionPendingTierAfterPeriodEnd: null,
          subscriptionGraceStartedAt: null,
          paystackSubscriptionCode: null,
          paystackSubscriptionEmailToken: null,
        }),
      },
      select: TENANT_ASSIGNMENT_FIELDS,
    }),

  unassign: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({
      where: { id: tenantId },
      data: { customTierId: null, customTierEndsAt: null, customTierAssignedAt: null, customTierEndingNoticeSentAt: null },
      select: TENANT_ASSIGNMENT_FIELDS,
    }),

  // ── The "ends in 7 days" email ──

  // Tenants whose custom tier ends within `within` of now and who haven't
  // had the email for this assignment and end date.
  findEndingSoon: (now: Date, until: Date, db: Db = prisma) =>
    db.tenant.findMany({
      where: {
        customTierId: { not: null },
        customTierEndsAt: { gt: now, lte: until },
        customTierEndingNoticeSentAt: null,
        isInternal: false,
      },
      select: { id: true, name: true, email: true, customTierEndsAt: true, customTier: { select: { name: true } } },
    }),

  // Claimed once: only the sweep whose write finds it unsent and still
  // ending on that date sends the email.
  claimEndingNotice: async (tenantId: string, endsAt: Date, now: Date, db: Db = prisma): Promise<boolean> =>
    (
      await db.tenant.updateMany({
        where: { id: tenantId, customTierEndingNoticeSentAt: null, customTierEndsAt: endsAt },
        data: { customTierEndingNoticeSentAt: now },
      })
    ).count === 1,
};
