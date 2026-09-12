import prisma from '../../shared/prisma/prisma.client.js';
import { Prisma } from '@prisma/client';
import { type RecordLedgerEntryInput } from './payment-ledger.types.js';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const paymentLedgerRepository: {
    create: (data: RecordLedgerEntryInput, db?: Db) => Prisma.Prisma__PaymentLedgerEntryClient<{
        id: string;
        createdAt: Date;
        tenantId: string | null;
        payload: Prisma.JsonValue | null;
        type: import("@prisma/client").$Enums.LedgerEntryType;
        amountCents: number;
        currency: string;
        eventId: string | null;
        paystackReference: string | null;
        relatedType: string | null;
        relatedId: string | null;
        occurredAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
export {};
//# sourceMappingURL=payment-ledger.repository.d.ts.map