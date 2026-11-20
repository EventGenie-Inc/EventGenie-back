import prisma from '../../shared/prisma/prisma.client.js';
import { Prisma, type LedgerEntryType } from '@prisma/client';
import { type RecordLedgerEntryInput } from './payment-ledger.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// The tenant's own billing history (GET /api/billing-history): its
// subscription's payments and changes, and refunds of what it bought
// (payments release 1).
const BILLING_HISTORY_TYPES = [
  'SUBSCRIPTION_CHARGE_SUCCEEDED',
  'SUBSCRIPTION_CHARGE_FAILED',
  'SUBSCRIPTION_TIER_CHANGED',
  'SUBSCRIPTION_CANCELLED',
] as const;
// Refunds of what the tenant itself paid for; a guest's ticket refund is
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
          { type: 'REFUND_ISSUED', relatedType: { in: TENANT_REFUND_RELATED_TYPES } },
        ],
      },
      orderBy: { occurredAt: 'desc' },
      select: { id: true, type: true, amountCents: true, currency: true, payload: true, occurredAt: true },
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
