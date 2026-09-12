import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const paymentWebhookRepository: {
    markProcessed: (eventType: string, dedupeKey: string, db?: Db) => Prisma.Prisma__PaystackWebhookEventClient<{
        id: string;
        eventType: string;
        dedupeKey: string;
        receivedAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
export {};
//# sourceMappingURL=payment-webhook.repository.d.ts.map