import prisma from '../../shared/prisma/prisma.client.js';
import { Prisma } from '@prisma/client';
import { type RecordLedgerEntryInput } from './payment-ledger.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  PAYMENT LEDGER REPOSITORY
//
//  APPEND-ONLY BY CONSTRUCTION. This is the only file in the codebase
//  that calls prisma.paymentLedgerEntry, and it exports exactly one
//  write method: create. There is no update, no delete, no archive —
//  not an oversight, a deliberate absence. An entry is a statement that
//  something happened, and things that happened do not stop having
//  happened. A correction is a NEW row, never an edit to this one — see
//  the model's own comment in schema.prisma. Do not add an update
//  method here later no matter how convenient a "fix a typo'd entry"
//  case seems.
//
//  Accepts an optional transaction client so the webhook flow
//  (payment-webhook.service.ts) can write the idempotency-guard row and
//  the ledger row atomically — both succeed or both fail together.
// ─────────────────────────────────────────
// Subscription-billing entries only — the same table also carries
// TICKET_PAYMENT_*/COMMISSION_TAKEN rows for ticket sales, which belong
// to the ticketing frontend's own (separate, later) history view, not a
// tenant's subscription Billing History. SUBSCRIPTION_CHARGE_INITIATED
// is deliberately excluded too: it's bookkeeping for an attempt still
// in flight — every attempt resolves to either a _SUCCEEDED or _FAILED
// row moments later, so showing INITIATED as well would just double up
// every charge with a row the tenant has no use for.
const BILLING_HISTORY_TYPES = [
  'SUBSCRIPTION_CHARGE_SUCCEEDED',
  'SUBSCRIPTION_CHARGE_FAILED',
  'SUBSCRIPTION_TIER_CHANGED',
  'SUBSCRIPTION_CANCELLED',
] as const;

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
        relatedType: data.relatedType ?? null,
        relatedId: data.relatedId ?? null,
        ...(data.payload !== undefined && { payload: data.payload ?? Prisma.JsonNull }),
        ...(data.occurredAt !== undefined && { occurredAt: data.occurredAt }),
      },
    }),

  // Tenant-scoped by construction (tenantId is a required arg, never
  // optional-with-bypass like event/guest repositories) — there is no
  // SUPER_ADMIN cross-tenant use case for a tenant's own billing
  // history, unlike the record-by-id lookups STEERING.md's tenant
  // scoping section describes.
  findBillingHistoryByTenant: (tenantId: string) =>
    prisma.paymentLedgerEntry.findMany({
      where: { tenantId, type: { in: [...BILLING_HISTORY_TYPES] } },
      orderBy: { occurredAt: 'desc' },
      select: { id: true, type: true, amountCents: true, currency: true, payload: true, occurredAt: true },
    }),
};
