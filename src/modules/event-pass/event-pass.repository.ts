import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma, type EventPassTier } from '@prisma/client';

type Db = Prisma.TransactionClient | typeof prisma;

export interface CreatePassPurchaseInput {
  eventId: string;
  tenantId: string;
  passTier: EventPassTier;
  isUpgrade: boolean;
  amountPaidCents: number;
  paymentRef: string;
}

export interface CreateSmsBundlePurchaseInput {
  eventId: string;
  tenantId: string;
  smsCount: number;
  amountPaidCents: number;
  paymentRef: string;
}

export const eventPassRepository = {
  // No isArchived filter — same as TicketPurchase/PaymentLedgerEntry,
  // this is a financial fact record, never soft-deleted.
  findByEventId: (eventId: string, db: Db = prisma) => db.eventPass.findUnique({ where: { eventId } }),

  findPurchaseByPaymentRef: (paymentRef: string, db: Db = prisma) =>
    db.eventPassPurchase.findFirst({ where: { paymentRef } }),

  createPurchase: (data: CreatePassPurchaseInput, db: Db = prisma) =>
    db.eventPassPurchase.create({
      data: {
        eventId: data.eventId,
        tenantId: data.tenantId,
        passTier: data.passTier,
        isUpgrade: data.isUpgrade,
        amountPaidCents: data.amountPaidCents,
        paymentRef: data.paymentRef,
        status: 'PENDING',
      },
    }),

  markPurchaseFailed: (paymentRef: string, db: Db = prisma) =>
    db.eventPassPurchase.updateMany({ where: { paymentRef, status: 'PENDING' }, data: { status: 'FAILED' } }),

  // The ONE activation point — confirms the purchase row AND grants (or
  // upgrades, in place) the event's EventPass together, inside the SAME
  // transaction the caller is already in (the webhook's own transaction —
  // see payment-webhook.service.ts). `upsert` keyed on eventId's @unique
  // constraint is what makes "first purchase" and "upgrade / re-purchase
  // after expiry" the same code path: create on first grant, update
  // passTier in place otherwise, never a second EventPass row for the
  // same event.
  confirmPurchase: async (
    purchase: { id: string; eventId: string; tenantId: string; passTier: EventPassTier },
    tx: Prisma.TransactionClient
  ) => {
    await tx.eventPassPurchase.update({
      where: { id: purchase.id },
      data: { status: 'PAID', confirmedAt: new Date() },
    });
    const pass = await tx.eventPass.upsert({
      where: { eventId: purchase.eventId },
      create: { eventId: purchase.eventId, tenantId: purchase.tenantId, passTier: purchase.passTier },
      update: { passTier: purchase.passTier },
    });
    await tx.eventPassPurchase.update({ where: { id: purchase.id }, data: { eventPassId: pass.id } });
    return pass;
  },

  findPurchasesForEvent: (eventId: string, db: Db = prisma) =>
    db.eventPassPurchase.findMany({ where: { eventId }, orderBy: { purchasedAt: 'desc' } }),

  // Repeat-purchase signal (event-pass.service.ts's getTenantPurchaseSignal)
  // — distinct events with at least one PAID purchase, for this tenant.
  countDistinctPassedEventsForTenant: async (tenantId: string): Promise<number> => {
    const rows = await prisma.eventPassPurchase.findMany({
      where: { tenantId, status: 'PAID' },
      distinct: ['eventId'],
      select: { eventId: true },
    });
    return rows.length;
  },

  // ── SMS bundle ──────────────────────────────────────────────────────

  findSmsBundlePurchaseByPaymentRef: (paymentRef: string, db: Db = prisma) =>
    db.eventSmsBundlePurchase.findFirst({ where: { paymentRef } }),

  createSmsBundlePurchase: (data: CreateSmsBundlePurchaseInput, db: Db = prisma) =>
    db.eventSmsBundlePurchase.create({
      data: {
        eventId: data.eventId,
        tenantId: data.tenantId,
        smsCount: data.smsCount,
        amountPaidCents: data.amountPaidCents,
        paymentRef: data.paymentRef,
        status: 'PENDING',
      },
    }),

  markSmsBundlePurchaseFailed: (paymentRef: string, db: Db = prisma) =>
    db.eventSmsBundlePurchase.updateMany({ where: { paymentRef, status: 'PENDING' }, data: { status: 'FAILED' } }),

  confirmSmsBundlePurchase: (id: string, tx: Prisma.TransactionClient) =>
    tx.eventSmsBundlePurchase.update({ where: { id }, data: { status: 'PAID', confirmedAt: new Date() } }),

  findSmsBundlePurchasesForEvent: (eventId: string, db: Db = prisma) =>
    db.eventSmsBundlePurchase.findMany({ where: { eventId }, orderBy: { purchasedAt: 'desc' } }),

  // Summed at read time from PAID rows only — never a running counter,
  // same convention as memoryHubRepository.sumBytesForEvent and the
  // payment ledger itself. Feeds sms-tier-enforcement.util.ts's bundle
  // balance check (purchased - used, where "used" comes from
  // smsSendLogRepository.countBundleUsedForEvent).
  sumPaidBundleSmsForEvent: async (eventId: string): Promise<number> => {
    const result = await prisma.eventSmsBundlePurchase.aggregate({
      where: { eventId, status: 'PAID' },
      _sum: { smsCount: true },
    });
    return result._sum.smsCount ?? 0;
  },
};
