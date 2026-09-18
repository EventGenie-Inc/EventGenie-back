import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type RecordLedgerEntryInput, type BillingHistoryEntryDto } from './payment-ledger.types.js';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const paymentLedgerService: {
    record: (input: RecordLedgerEntryInput, db?: Db) => Prisma.Prisma__PaymentLedgerEntryClient<{
        id: string;
        createdAt: Date;
        tenantId: string | null;
        payload: Prisma.JsonValue | null;
        eventId: string | null;
        type: import("@prisma/client").$Enums.LedgerEntryType;
        amountCents: number;
        currency: string;
        paystackReference: string | null;
        relatedType: string | null;
        relatedId: string | null;
        occurredAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    listBillingHistoryForTenant: (tenantId: string) => Promise<BillingHistoryEntryDto[]>;
};
export {};
//# sourceMappingURL=payment-ledger.service.d.ts.map