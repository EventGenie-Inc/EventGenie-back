import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma, type PaystackSubaccountStatus, type PayoutAccountChangeKind } from '@prisma/client';

type Db = Prisma.TransactionClient | typeof prisma;

// The tenant's CURRENT payout account (where sales are paid now), with the
// plan inputs payment-account-readiness.util.ts needs beside it.
const tenantStatusSelect = {
  id: true,
  name: true,
  // The plan inputs (effective-plan.util.ts's resolveTenantPlan), for
  // payment-account-readiness.util.ts.
  subscriptionTier: true,
  subscriptionCancelAtPeriodEnd: true,
  subscriptionCurrentPeriodEnd: true,
  subscriptionGraceStartedAt: true,
  customTierId: true,
  customTierEndsAt: true,
  paystackSubaccountCode: true,
  paystackSubaccountStatus: true,
  paystackBusinessName: true,
  paystackSettlementBankCode: true,
  paystackSettlementBankName: true,
  paystackAccountNumberLast4: true,
  paystackAccountHolderName: true,
  paystackSubaccountFailureReason: true,
  paystackSubaccountActiveSince: true,
} satisfies Prisma.TenantSelect;

export type TenantPayoutRow = Prisma.TenantGetPayload<{ select: typeof tenantStatusSelect }>;

const OPEN = ['CREATING', 'PENDING'] as const;

export const paymentAccountRepository = {
  findStatusByTenantId: (tenantId: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { id: tenantId }, select: tenantStatusSelect }),

  // The first setup refused: the tenant has no account, so saying so on the
  // tenant hides nothing that works. Never called while an account is in
  // use (a refused CHANGE leaves the current account exactly as it was).
  markSetupFailed: (tenantId: string, reason: string) =>
    prisma.tenant.updateMany({
      where: { id: tenantId, paystackSubaccountCode: null },
      data: { paystackSubaccountStatus: 'FAILED', paystackSubaccountFailureReason: reason },
    }),

  cacheVisibleDetails: (tenantId: string, data: { businessName: string; settlementBankName: string; accountNumberLast4: string }) =>
    prisma.tenant.update({
      where: { id: tenantId },
      data: {
        paystackBusinessName: data.businessName,
        paystackSettlementBankName: data.settlementBankName,
        paystackAccountNumberLast4: data.accountNumberLast4,
      },
    }),

  findOpenChange: (tenantId: string, db: Db = prisma) =>
    db.payoutAccountChange.findFirst({ where: { tenantId, status: { in: [...OPEN] } } }),

  findChangeById: (id: string, db: Db = prisma) => db.payoutAccountChange.findUnique({ where: { id } }),

  findChangeByCancelTokenHash: (hash: string) => prisma.payoutAccountChange.findUnique({ where: { cancelTokenHash: hash } }),

  // Throws a unique violation on PayoutAccountChange_one_open_per_tenant
  // when another open change exists (two requests racing).
  createChange: (data: {
    tenantId: string;
    kind: PayoutAccountChangeKind;
    creationKey: string;
    businessName: string;
    bankCode: string;
    bankName: string;
    accountNumberLast4: string;
    accountHolderName: string;
    effectiveAt: Date;
    requestedByUserId: string;
    cancelTokenHash: string | null;
    cancelTokenExpiresAt: Date | null;
  }) => prisma.payoutAccountChange.create({ data: { ...data, status: 'CREATING' } }),

  // A re-submission while the change is still unconfirmed: the same row (and
  // creationKey), with what was typed this time.
  refreshUnconfirmedChange: (
    id: string,
    data: { businessName: string; bankCode: string; bankName: string; accountNumberLast4: string; accountHolderName: string }
  ) => prisma.payoutAccountChange.updateMany({ where: { id, status: 'CREATING', subaccountCode: null }, data }),

  recordAttempt: (id: string, data: { error: string | null; nextAttemptAt: Date | null }) =>
    prisma.payoutAccountChange.update({
      where: { id },
      data: { creationAttempts: { increment: 1 }, lastAttemptError: data.error, nextAttemptAt: data.nextAttemptAt },
    }),

  // The subaccount is confirmed: CREATING → PENDING. Conditional, so a
  // cancel that won the race stays cancelled.
  markCreated: async (id: string, data: { subaccountCode: string; subaccountActive: boolean }): Promise<boolean> =>
    (
      await prisma.payoutAccountChange.updateMany({
        where: { id, status: 'CREATING' },
        data: { status: 'PENDING', subaccountCode: data.subaccountCode, subaccountActive: data.subaccountActive, lastAttemptError: null, nextAttemptAt: null },
      })
    ).count === 1,

  markFailed: async (id: string, reason: string): Promise<boolean> =>
    (
      await prisma.payoutAccountChange.updateMany({
        where: { id, status: { in: [...OPEN] } },
        data: { status: 'FAILED', failureReason: reason, nextAttemptAt: null },
      })
    ).count === 1,

  // Cancels the tenant's open change, once: by the app (a Tenant Admin) or by
  // the email link (whose token is spent in the same write).
  cancelOpen: async (
    where: { id: string },
    data: { via: 'APP' | 'EMAIL_LINK'; userId: string | null; now: Date }
  ): Promise<boolean> =>
    (
      await prisma.payoutAccountChange.updateMany({
        where: {
          id: where.id,
          status: { in: [...OPEN] },
          ...(data.via === 'EMAIL_LINK' && { cancelTokenUsedAt: null, cancelTokenExpiresAt: { gt: data.now } }),
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: data.now,
          cancelledVia: data.via,
          cancelledByUserId: data.userId,
          nextAttemptAt: null,
          ...(data.via === 'EMAIL_LINK' && { cancelTokenUsedAt: data.now }),
        },
      })
    ).count === 1,

  // The worker's work: changes whose subaccount still needs confirming, and
  // confirmed ones whose time has come.
  findDueForConfirmation: (now: Date, tenantIds?: string[]) =>
    prisma.payoutAccountChange.findMany({
      where: {
        status: 'CREATING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        ...(tenantIds && { tenantId: { in: tenantIds } }),
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),

  findDueToApply: (now: Date, tenantIds?: string[]) =>
    prisma.payoutAccountChange.findMany({
      where: {
        status: 'PENDING',
        effectiveAt: { lte: now },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        ...(tenantIds && { tenantId: { in: tenantIds } }),
      },
      orderBy: { effectiveAt: 'asc' },
      take: 50,
    }),

  // Makes the change the tenant's current account, once: the change's own
  // PENDING → APPLIED decides, in the same transaction as the tenant's write.
  apply: (
    change: { id: string; tenantId: string; subaccountCode: string; businessName: string; bankCode: string; bankName: string; accountNumberLast4: string; accountHolderName: string },
    status: PaystackSubaccountStatus,
    now: Date
  ): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
      // What it replaces, read under the claim: deactivated at Paystack once
      // this write has committed (never before the switch).
      const previous = await tx.tenant.findUniqueOrThrow({
        where: { id: change.tenantId },
        select: { paystackSubaccountCode: true, paystackBusinessName: true, paystackSettlementBankCode: true },
      });
      const replaced = previous.paystackSubaccountCode && previous.paystackSubaccountCode !== change.subaccountCode ? previous : null;
      const claimed = await tx.payoutAccountChange.updateMany({
        where: { id: change.id, status: 'PENDING' },
        data: {
          status: 'APPLIED',
          appliedAt: now,
          nextAttemptAt: null,
          lastAttemptError: null,
          replacedSubaccountCode: replaced?.paystackSubaccountCode ?? null,
          replacedBusinessName: replaced?.paystackBusinessName ?? null,
          replacedBankCode: replaced?.paystackSettlementBankCode ?? null,
        },
      });
      if (claimed.count !== 1) return false;
      await tx.tenant.update({
        where: { id: change.tenantId },
        data: {
          paystackSubaccountCode: change.subaccountCode,
          paystackSubaccountStatus: status,
          paystackBusinessName: change.businessName,
          paystackSettlementBankCode: change.bankCode,
          paystackSettlementBankName: change.bankName,
          paystackAccountNumberLast4: change.accountNumberLast4,
          paystackAccountHolderName: change.accountHolderName,
          paystackSubaccountFailureReason: null,
          paystackSubaccountActiveSince: now,
        },
      });
      return true;
    }),

  // Subaccounts to deactivate at Paystack: a cancelled or failed change's
  // own, and what an applied change replaced; each not yet done and due.
  findDueForDeactivation: (now: Date, tenantIds?: string[]) =>
    prisma.payoutAccountChange.findMany({
      where: {
        OR: [
          { status: { in: ['CANCELLED', 'FAILED'] }, subaccountCode: { not: null }, subaccountDeactivatedAt: null },
          { status: 'APPLIED', replacedSubaccountCode: { not: null }, replacedDeactivatedAt: null },
        ],
        AND: [{ OR: [{ nextDeactivationAt: null }, { nextDeactivationAt: { lte: now } }] }],
        ...(tenantIds && { tenantId: { in: tenantIds } }),
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    }),

  markDeactivated: (id: string, which: 'OWN' | 'REPLACED', now: Date) =>
    prisma.payoutAccountChange.update({
      where: { id },
      data: {
        ...(which === 'OWN' ? { subaccountDeactivatedAt: now } : { replacedDeactivatedAt: now }),
        nextDeactivationAt: null,
        lastDeactivationError: null,
      },
    }),

  deferDeactivation: (id: string, error: string, nextDeactivationAt: Date) =>
    prisma.payoutAccountChange.update({
      where: { id },
      data: { deactivationAttempts: { increment: 1 }, lastDeactivationError: error, nextDeactivationAt },
    }),

  deferApply: (id: string, error: string, nextAttemptAt: Date) =>
    prisma.payoutAccountChange.update({ where: { id }, data: { lastAttemptError: error, nextAttemptAt } }),

  // Who is told about a payout account: the organisation's Tenant Admins.
  findTenantAdminEmails: async (tenantId: string): Promise<string[]> =>
    (
      await prisma.user.findMany({
        where: { tenantId, role: 'TENANT_ADMIN', isActive: true, isArchived: false },
        select: { email: true },
        orderBy: { createdAt: 'asc' },
      })
    ).map((u) => u.email),
};
