import { type LedgerEntryType, type Prisma } from '@prisma/client';
export interface RecordLedgerEntryInput {
    type: LedgerEntryType;
    amountCents: number;
    currency?: string;
    tenantId?: string | null;
    eventId?: string | null;
    paystackReference?: string | null;
    relatedType?: string | null;
    relatedId?: string | null;
    payload?: Prisma.InputJsonValue | null;
    occurredAt?: Date;
}
//# sourceMappingURL=payment-ledger.types.d.ts.map