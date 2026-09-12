import * as paystackClient from '../../shared/payments/paystack.client.js';
import { type SubmitSubaccountDto, type UpdateSubaccountDto, type SubaccountStatusDto } from './payment-account.types.js';
export declare const paymentAccountService: {
    getStatus: (tenantId: string) => Promise<SubaccountStatusDto>;
    listBanks: () => Promise<paystackClient.PaystackBank[]>;
    submit: (tenantId: string, data: SubmitSubaccountDto) => Promise<{
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
    }>;
    update: (tenantId: string, data: UpdateSubaccountDto) => Promise<{
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
    }>;
};
//# sourceMappingURL=payment-account.service.d.ts.map