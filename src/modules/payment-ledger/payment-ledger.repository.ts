import prisma from '../../shared/prisma/prisma.client.js';
import { Prisma, type LedgerEntryType } from '@prisma/client';
import { type RecordLedgerEntryInput } from './payment-ledger.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// The tenant's own billing history (GET /api/billing-history): its
// subscription's payments and changes, every Event Pass and SMS bundle
// payment (follow-ups to payments release 1), and refunds of what it
// bought.
const BILLING_HISTORY_TYPES = [
  'SUBSCRIPTION_CHARGE_SUCCEEDED',
  'SUBSCRIPTION_CHARGE_FAILED',
  'SUBSCRIPTION_TIER_CHANGED',
  'SUBSCRIPTION_CANCELLED',
  'EVENT_PASS_PURCHASE_SUCCEEDED',
  'EVENT_PASS_PURCHASE_FAILED',
  'SMS_BUNDLE_PURCHASE_SUCCEEDED',
  'SMS_BUNDLE_PURCHASE_FAILED',
] as const;
// Refunds (REFUND_ISSUED), reversals (DISPUTE_LOST, a chargeback lost) and
// payments that granted nothing (PAYMENT_DUPLICATE, PAYMENT_AMOUNT_MISMATCH)
// of what the tenant itself paid for; a guest's ticket payment or refund is
// not the organiser's billing.
const TENANT_REFUND_RELATED_TYPES = ['Tenant', 'EventPassPurchase', 'EventSmsBundlePurchase'];

// What reconciliation counts as "money arrived": one row per successful
// payment of any kind.
export const LEDGER_SUCCESS_TYPES: LedgerEntryType[] = [
  'TICKET_PAYMENT_SUCCEEDED',
  'SUBSCRIPTION_CHARGE_SUCCEEDED',
  'EVENT_PASS_PURCHASE_SUCCEEDED',
  'SMS_BUNDLE_PURCHASE_SUCCEEDED',
];

export interface LedgerListFilter {
  tenantId?: string;
  eventId?: string;
  types?: LedgerEntryType[];
  reference?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export const paymentLedgerRepository = {
  create: (data: RecordLedgerEntryInput, db: Db = prisma) =>
    db.paymentLedgerEntry.create({
      data: {
        type: data.type,
        amountCents: data.amountCents,
        currency: data.currency ?? 'ZAR',
        tenantId: data.tenantId ?? null,
        eventId: data.eventId ?? null,
        paystackReference: data.paystackReference ?? null,
        paystackTransactionId: data.paystackTransactionId ?? null,
        relatedType: data.relatedType ?? null,
        relatedId: data.relatedId ?? null,
        ...(data.payload !== undefined && { payload: data.payload ?? Prisma.JsonNull }),
        ...(data.occurredAt !== undefined && { occurredAt: data.occurredAt }),
      },
    }),

  findBillingHistoryByTenant: (tenantId: string) =>
    prisma.paymentLedgerEntry.findMany({
      where: {
        tenantId,
        OR: [
          { type: { in: [...BILLING_HISTORY_TYPES] } },
          {
            type: { in: ['REFUND_ISSUED', 'DISPUTE_LOST', 'PAYMENT_DUPLICATE', 'PAYMENT_AMOUNT_MISMATCH'] },
            relatedType: { in: TENANT_REFUND_RELATED_TYPES },
          },
        ],
      },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        type: true,
        amountCents: true,
        currency: true,
        payload: true,
        occurredAt: true,
        relatedType: true,
        eventId: true,
        event: { select: { name: true } },
      },
    }),

  // Idempotency for handlers whose webhook may be redelivered with
  // different bytes: has this exact fact already been written?
  existsFor: async (type: LedgerEntryType, keys: { reference?: string | null; transactionId?: string | null }, db: Db = prisma): Promise<boolean> => {
    const or: Prisma.PaymentLedgerEntryWhereInput[] = [];
    if (keys.reference) or.push({ paystackReference: keys.reference });
    if (keys.transactionId) or.push({ paystackTransactionId: keys.transactionId });
    if (or.length === 0) return false;
    const found = await db.paymentLedgerEntry.findFirst({ where: { type, OR: or }, select: { id: true } });
    return found !== null;
  },

  // The successful payment a refund or dispute is about, by our reference
  // or Paystack's transaction id.
  findSuccessFor: (keys: { reference: string | null; transactionId: string | null }, db: Db = prisma) => {
    const or: Prisma.PaymentLedgerEntryWhereInput[] = [];
    if (keys.reference) or.push({ paystackReference: keys.reference });
    if (keys.transactionId) or.push({ paystackTransactionId: keys.transactionId });
    if (or.length === 0) return Promise.resolve(null);
    return db.paymentLedgerEntry.findFirst({
      where: { type: { in: LEDGER_SUCCESS_TYPES }, OR: or },
      orderBy: { createdAt: 'asc' },
    });
  },

  // The tenant's most recent subscription payment: a refund of THIS one
  // ends the subscription (a refund of an older one is recorded only).
  findLatestSubscriptionCharge: (tenantId: string, db: Db = prisma) =>
    db.paymentLedgerEntry.findFirst({
      where: { tenantId, type: 'SUBSCRIPTION_CHARGE_SUCCEEDED' },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    }),

  // The tenant's most recent subscription payment attempt of any outcome
  // (GET /api/subscriptions' latestPayment): started, paid, failed,
  // uncertain, or paid the wrong amount. Newest recorded first.
  // This tenant's own subscribe checkouts' references (our sub_ ones, from
  // their INITIATED rows).
  findOwnSubscribeReferences: async (tenantId: string, db: Db = prisma): Promise<string[]> =>
    (
      await db.paymentLedgerEntry.findMany({
        where: { tenantId, type: 'SUBSCRIPTION_CHARGE_INITIATED', paystackReference: { startsWith: 'sub_' } },
        select: { paystackReference: true },
      })
    ).map((r) => r.paystackReference as string),

  // charge.success deliveries nothing claimed (WEBHOOK_EVENT_UNHANDLED, no
  // tenant) by one of these references, or naming this customer code.
  // Newest first. latest-subscription-payment.util.ts decides which are
  // safely the tenant's.
  findUnclaimedCharges: (keys: { references: string[]; customerCode: string | null }, db: Db = prisma) => {
    const or: Prisma.PaymentLedgerEntryWhereInput[] = [];
    if (keys.references.length) or.push({ paystackReference: { in: keys.references } });
    if (keys.customerCode) or.push({ payload: { path: ['data', 'customer', 'customer_code'], equals: keys.customerCode } });
    if (or.length === 0) return Promise.resolve([]);
    return db.paymentLedgerEntry.findMany({
      where: { type: 'WEBHOOK_EVENT_UNHANDLED', relatedId: 'charge.success', tenantId: null, OR: or },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
  },

  findLatestSubscriptionPaymentRow: (tenantId: string, db: Db = prisma) =>
    db.paymentLedgerEntry.findFirst({
      where: {
        tenantId,
        OR: [
          {
            type: {
              in: [
                'SUBSCRIPTION_CHARGE_INITIATED',
                'SUBSCRIPTION_CHARGE_SUCCEEDED',
                'SUBSCRIPTION_CHARGE_FAILED',
                'SUBSCRIPTION_CHARGE_UNCERTAIN',
              ],
            },
          },
          { type: { in: ['PAYMENT_AMOUNT_MISMATCH', 'PAYMENT_DUPLICATE'] }, relatedType: 'Tenant' },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),

  // A subscribe checkout's own INITIATED row, by our reference (a renewal's
  // reference is Paystack's and has none).
  findSubscribeInitiated: (reference: string, db: Db = prisma) =>
    db.paymentLedgerEntry.findFirst({ where: { type: 'SUBSCRIPTION_CHARGE_INITIATED', paystackReference: reference } }),

  // A subscription payment recorded after `since` (a newer checkout paid,
  // or a renewal): what makes a stale checkout's late payment a duplicate.
  findSubscriptionSuccessSince: (tenantId: string, since: Date, db: Db = prisma) =>
    db.paymentLedgerEntry.findFirst({
      where: { tenantId, type: 'SUBSCRIPTION_CHARGE_SUCCEEDED', createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
    }),

  // Refunds and lost chargebacks recorded against one payment, by our
  // reference or Paystack's transaction id. Newest first.
  findTakeBacksFor: (keys: { reference: string | null; transactionId: string | null }, db: Db = prisma) => {
    const or: Prisma.PaymentLedgerEntryWhereInput[] = [];
    if (keys.reference) or.push({ paystackReference: keys.reference });
    if (keys.transactionId) or.push({ paystackTransactionId: keys.transactionId });
    if (or.length === 0) return Promise.resolve([]);
    return db.paymentLedgerEntry.findMany({
      where: { type: { in: ['REFUND_ISSUED', 'DISPUTE_LOST'] }, OR: or },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  // Reconciliation: every success recorded for a window.
  findSuccessesBetween: (from: Date, to: Date, tenantIds?: string[]) =>
    prisma.paymentLedgerEntry.findMany({
      where: {
        type: { in: LEDGER_SUCCESS_TYPES },
        occurredAt: { gte: from, lt: to },
        ...(tenantIds && { tenantId: { in: tenantIds } }),
      },
    }),

  findByReferences: (references: string[], types: LedgerEntryType[]) =>
    references.length === 0
      ? Promise.resolve([])
      : prisma.paymentLedgerEntry.findMany({ where: { paystackReference: { in: references }, type: { in: types } } }),

  // Super admin view, newest first, cursor-paged.
  list: (filter: LedgerListFilter) =>
    prisma.paymentLedgerEntry.findMany({
      where: {
        ...(filter.tenantId && { tenantId: filter.tenantId }),
        ...(filter.eventId && { eventId: filter.eventId }),
        ...(filter.types && { type: { in: filter.types } }),
        ...(filter.reference && {
          OR: [{ paystackReference: filter.reference }, { paystackTransactionId: filter.reference }],
        }),
        ...((filter.from || filter.to) && {
          occurredAt: { ...(filter.from && { gte: filter.from }), ...(filter.to && { lt: filter.to }) },
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
      ...(filter.cursor && { cursor: { id: filter.cursor }, skip: 1 }),
    }),
};
