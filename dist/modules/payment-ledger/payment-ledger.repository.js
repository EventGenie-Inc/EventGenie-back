import prisma from '../../shared/prisma/prisma.client.js';
import { Prisma } from '@prisma/client';
import {} from './payment-ledger.types.js';
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
export const paymentLedgerRepository = {
    create: (data, db = prisma) => db.paymentLedgerEntry.create({
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
};
//# sourceMappingURL=payment-ledger.repository.js.map