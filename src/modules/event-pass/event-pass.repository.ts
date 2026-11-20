import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma, type EventPassTier, type PaymentAttemptStatus } from '@prisma/client';

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

// Statuses a confirmation may move to PAID from (payments release 1): a
// still-pending attempt, or one marked FAILED (a failed attempt on the same
// checkout, the init failing after Paystack had created it, the stale sweep)
// that Paystack now reports paid. Never from REFUNDED, REVERSED or
// UNDER_REVIEW: those were decided on purpose.
export const CONFIRMABLE_STATUSES: PaymentAttemptStatus[] = ['PENDING', 'FAILED'];

export interface PaidDetails {
  paystackTransactionId: string | null;
}

export const eventPassRepository = {
  // No isArchived filter — same as TicketPurchase/PaymentLedgerEntry,
  // this is a financial fact record, never soft-deleted.
  findByEventId: (eventId: string, db: Db = prisma) => db.eventPass.findUnique({ where: { eventId } }),

  // Scoped to the event in the URL: a purchase id from another event (the
  // same tenant's or not) is not found. The event itself is tenant-gated by
  // the caller (eventService.getById) before this runs.
  findPurchaseForEvent: (id: string, eventId: string) =>
    prisma.eventPassPurchase.findFirst({ where: { id, eventId } }),

  findSmsBundlePurchaseForEvent: (id: string, eventId: string) =>
    prisma.eventSmsBundlePurchase.findFirst({ where: { id, eventId } }),

  findPurchaseByPaymentRef: (paymentRef: string, db: Db = prisma) =>
    db.eventPassPurchase.findFirst({ where: { paymentRef } }),

  // Refund and dispute matching: by our reference or Paystack's id.
  findPurchaseByPaymentKeys: (keys: { reference: string | null; transactionId: string | null }, db: Db = prisma) => {
    const or: Prisma.EventPassPurchaseWhereInput[] = [];
    if (keys.reference) or.push({ paymentRef: keys.reference });
    if (keys.transactionId) or.push({ paystackTransactionId: keys.transactionId });
    return or.length === 0 ? Promise.resolve(null) : db.eventPassPurchase.findFirst({ where: { OR: or } });
  },

  // The pending attempt a second purchase reuses (pending-checkout.util.ts).
  findRecentPendingPurchase: (eventId: string, since: Date, db: Db = prisma) =>
    db.eventPassPurchase.findFirst({
      where: { eventId, status: 'PENDING', purchasedAt: { gte: since } },
      orderBy: { purchasedAt: 'desc' },
    }),

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

  saveAuthorizationUrl: (id: string, authorizationUrl: string, db: Db = prisma) =>
    db.eventPassPurchase.update({ where: { id }, data: { authorizationUrl } }),

  markPurchaseFailed: (paymentRef: string, db: Db = prisma) =>
    db.eventPassPurchase.updateMany({ where: { paymentRef, status: 'PENDING' }, data: { status: 'FAILED' } }),

  // The ONE activation point — confirms the purchase row AND grants (or
  // upgrades, in place) the event's EventPass together, inside the SAME
  // transaction the caller is already in (the webhook's own transaction —
  // see payment-webhook.service.ts). `upsert` keyed on eventId's @unique
  // constraint is what makes "first purchase" and "upgrade / re-purchase
  // after expiry" the same code path.
  //
  // Payments release 1: the pass only ever RAISES the event's tier. A late
  // confirmation of a cheaper purchase (an abandoned SMALL checkout paid
  // after a LARGE upgrade) is recorded as paid but leaves the pass where
  // it is; `kept` tells the caller so it can alert (the tenant paid for
  // nothing, a refund may be due).
  confirmPurchase: async (
    purchase: { id: string; eventId: string; tenantId: string; passTier: EventPassTier },
    rank: Record<EventPassTier, number>,
    paid: PaidDetails,
    tx: Prisma.TransactionClient
  ): Promise<{ passId: string; passTier: EventPassTier; kept: boolean }> => {
    await tx.eventPassPurchase.update({
      where: { id: purchase.id },
      data: { status: 'PAID', confirmedAt: new Date(), paystackTransactionId: paid.paystackTransactionId },
    });
    const existing = await tx.eventPass.findUnique({ where: { eventId: purchase.eventId } });
    const kept = existing !== null && rank[existing.passTier] >= rank[purchase.passTier];
    const pass = existing
      ? kept
        ? existing
        : await tx.eventPass.update({ where: { id: existing.id }, data: { passTier: purchase.passTier } })
      : await tx.eventPass.create({ data: { eventId: purchase.eventId, tenantId: purchase.tenantId, passTier: purchase.passTier } });
    await tx.eventPassPurchase.update({ where: { id: purchase.id }, data: { eventPassId: pass.id } });
    return { passId: pass.id, passTier: pass.passTier, kept };
  },

  markPurchaseUnderReview: (id: string, paid: PaidDetails, tx: Prisma.TransactionClient) =>
    tx.eventPassPurchase.update({ where: { id }, data: { status: 'UNDER_REVIEW', paystackTransactionId: paid.paystackTransactionId } }),

  // Refund (REFUNDED) or lost chargeback (REVERSED): the purchase is taken
  // back, then the event's pass is recomputed from what remains PAID.
  markPurchaseTakenBack: (id: string, status: 'REFUNDED' | 'REVERSED', tx: Prisma.TransactionClient) =>
    tx.eventPassPurchase.update({ where: { id }, data: { status } }),

  findPaidPurchasesForEvent: (eventId: string, tx: Prisma.TransactionClient) =>
    tx.eventPassPurchase.findMany({ where: { eventId, status: 'PAID' }, orderBy: { purchasedAt: 'asc' } }),

  setPassTier: (eventId: string, passTier: EventPassTier, tx: Prisma.TransactionClient) =>
    tx.eventPass.update({ where: { eventId }, data: { passTier } }),

  // The event falls back to its tenant's own plan: the EventPass row goes
  // (every purchase row stays, with its status, and every ledger row). The
  // purchases' link to it is cleared first. Nothing of the event's own data
  // is touched.
  removePass: async (eventId: string, tx: Prisma.TransactionClient): Promise<void> => {
    const pass = await tx.eventPass.findUnique({ where: { eventId } });
    if (!pass) return;
    await tx.eventPassPurchase.updateMany({ where: { eventPassId: pass.id }, data: { eventPassId: null } });
    await tx.eventPass.delete({ where: { id: pass.id } });
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

  // Stale sweep (payment-maintenance.service.ts): still PENDING since before
  // the cutoff. `tenantIds` scopes a test's run to its own tenants.
  findStalePendingPurchases: (before: Date, tenantIds?: string[]) =>
    prisma.eventPassPurchase.findMany({
      where: { status: 'PENDING', purchasedAt: { lt: before }, ...(tenantIds && { tenantId: { in: tenantIds } }) },
      take: 200,
    }),

  // ── SMS bundle ──────────────────────────────────────────────────────

  findSmsBundlePurchaseByPaymentRef: (paymentRef: string, db: Db = prisma) =>
    db.eventSmsBundlePurchase.findFirst({ where: { paymentRef } }),

  findSmsBundlePurchaseByPaymentKeys: (keys: { reference: string | null; transactionId: string | null }, db: Db = prisma) => {
    const or: Prisma.EventSmsBundlePurchaseWhereInput[] = [];
    if (keys.reference) or.push({ paymentRef: keys.reference });
    if (keys.transactionId) or.push({ paystackTransactionId: keys.transactionId });
    return or.length === 0 ? Promise.resolve(null) : db.eventSmsBundlePurchase.findFirst({ where: { OR: or } });
  },

  findRecentPendingSmsBundlePurchase: (eventId: string, since: Date, db: Db = prisma) =>
    db.eventSmsBundlePurchase.findFirst({
      where: { eventId, status: 'PENDING', purchasedAt: { gte: since } },
      orderBy: { purchasedAt: 'desc' },
    }),

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

  saveSmsBundleAuthorizationUrl: (id: string, authorizationUrl: string, db: Db = prisma) =>
    db.eventSmsBundlePurchase.update({ where: { id }, data: { authorizationUrl } }),

  markSmsBundlePurchaseFailed: (paymentRef: string, db: Db = prisma) =>
    db.eventSmsBundlePurchase.updateMany({ where: { paymentRef, status: 'PENDING' }, data: { status: 'FAILED' } }),

  confirmSmsBundlePurchase: (id: string, paid: PaidDetails, tx: Prisma.TransactionClient) =>
    tx.eventSmsBundlePurchase.update({
      where: { id },
      data: { status: 'PAID', confirmedAt: new Date(), paystackTransactionId: paid.paystackTransactionId },
    }),

  markSmsBundleUnderReview: (id: string, paid: PaidDetails, tx: Prisma.TransactionClient) =>
    tx.eventSmsBundlePurchase.update({ where: { id }, data: { status: 'UNDER_REVIEW', paystackTransactionId: paid.paystackTransactionId } }),

  // A refunded or reversed bundle stops counting towards the event's
  // purchased credits (sumPaidBundleSmsForEvent reads PAID only), which is
  // what removes its remaining credits: credits already sent stay sent.
  markSmsBundleTakenBack: (id: string, status: 'REFUNDED' | 'REVERSED', tx: Prisma.TransactionClient) =>
    tx.eventSmsBundlePurchase.update({ where: { id }, data: { status } }),

  findSmsBundlePurchasesForEvent: (eventId: string, db: Db = prisma) =>
    db.eventSmsBundlePurchase.findMany({ where: { eventId }, orderBy: { purchasedAt: 'desc' } }),

  findStalePendingSmsBundlePurchases: (before: Date, tenantIds?: string[]) =>
    prisma.eventSmsBundlePurchase.findMany({
      where: { status: 'PENDING', purchasedAt: { lt: before }, ...(tenantIds && { tenantId: { in: tenantIds } }) },
      take: 200,
    }),

  // Summed at read time from PAID rows only — never a running counter,
  // same convention as memoryHubRepository.sumBytesForEvent and the
  // payment ledger itself. Feeds sms-tier-enforcement.util.ts's bundle
  // balance check (purchased - used, where "used" comes from
  // smsSendLogRepository.countBundleUsedForEvent).
  sumPaidBundleSmsForEvent: async (eventId: string, db: Db = prisma): Promise<number> => {
    const result = await db.eventSmsBundlePurchase.aggregate({
      where: { eventId, status: 'PAID' },
      _sum: { smsCount: true },
    });
    return result._sum.smsCount ?? 0;
  },
};
