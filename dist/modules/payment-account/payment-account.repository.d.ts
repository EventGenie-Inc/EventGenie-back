import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma, type PaystackSubaccountStatus } from '@prisma/client';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const paymentAccountRepository: {
    findStatusByTenantId: (tenantId: string, db?: Db) => Prisma.Prisma__TenantClient<{
        id: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        paystackSubaccountCode: string | null;
        paystackSubaccountStatus: import("@prisma/client").$Enums.PaystackSubaccountStatus;
        paystackBusinessName: string | null;
        paystackSettlementBankCode: string | null;
        paystackSettlementBankName: string | null;
        paystackSubaccountFailureReason: string | null;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    saveSubaccount: (tenantId: string, data: {
        subaccountCode: string;
        status: PaystackSubaccountStatus;
        businessName: string;
        settlementBankCode: string | null;
        settlementBankName: string | null;
    }) => Prisma.Prisma__TenantClient<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        paystackSubaccountCode: string | null;
        paystackSubaccountStatus: import("@prisma/client").$Enums.PaystackSubaccountStatus;
        paystackBusinessName: string | null;
        paystackSettlementBankCode: string | null;
        paystackSettlementBankName: string | null;
        paystackSubaccountFailureReason: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    markFailed: (tenantId: string, reason: string) => Prisma.Prisma__TenantClient<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        paystackSubaccountCode: string | null;
        paystackSubaccountStatus: import("@prisma/client").$Enums.PaystackSubaccountStatus;
        paystackBusinessName: string | null;
        paystackSettlementBankCode: string | null;
        paystackSettlementBankName: string | null;
        paystackSubaccountFailureReason: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
export {};
//# sourceMappingURL=payment-account.repository.d.ts.map