import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const assertTenantReadyToSellTickets: (tenantId: string, db?: Db) => Promise<{
    subaccountCode: string;
}>;
export {};
//# sourceMappingURL=payment-account-readiness.util.d.ts.map