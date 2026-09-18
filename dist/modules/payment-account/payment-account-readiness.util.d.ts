import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const assertTenantReadyToSellTickets: (tenantId: string, db?: Db) => Promise<{
    subaccountCode: string;
}>;
export declare const assertEventReadyToSellTickets: (event: EntitlementDerivableEvent, db?: Db) => Promise<{
    subaccountCode: string;
}>;
export declare const assertSubaccountReadyForPurchase: (tenantId: string, db?: Db) => Promise<{
    subaccountCode: string;
}>;
export {};
//# sourceMappingURL=payment-account-readiness.util.d.ts.map