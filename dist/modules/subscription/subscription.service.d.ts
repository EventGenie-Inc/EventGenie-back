import { type Prisma } from '@prisma/client';
import { isPaidTier, type PaidSubscriptionTier } from './subscription-plans.config.js';
import { type SubscribeDto, type ChangeTierDto, type SubscriptionStatusDto, type CheckoutResult, type ChangeTierResult, type SubscriptionPricingDto } from './subscription.types.js';
export declare const subscriptionService: {
    getPricing: () => SubscriptionPricingDto;
    getStatus: (tenantId: string) => Promise<SubscriptionStatusDto>;
    subscribe: (tenantId: string, dto: SubscribeDto, callbackUrl: string) => Promise<CheckoutResult>;
    changeTier: (tenantId: string, dto: ChangeTierDto) => Promise<ChangeTierResult>;
    getUpdateCardLink: (tenantId: string) => Promise<{
        link: string;
    }>;
    cancel: (tenantId: string) => Promise<{
        effectiveAt: Date | null;
    }>;
    handleChargeSuccessWithinTransaction: (tx: Prisma.TransactionClient, data: Record<string, unknown>) => Promise<{
        claimed: boolean;
        postCommit?: () => Promise<void>;
    }>;
    handleChargeFailedWithinTransaction: (tx: Prisma.TransactionClient, data: Record<string, unknown>) => Promise<{
        claimed: boolean;
    }>;
    handleSubscriptionCreateWithinTransaction: (tx: Prisma.TransactionClient, data: Record<string, unknown>) => Promise<{
        claimed: boolean;
    }>;
    handleSubscriptionDisableWithinTransaction: (tx: Prisma.TransactionClient, data: Record<string, unknown>) => Promise<{
        claimed: boolean;
    }>;
};
export { isPaidTier, type PaidSubscriptionTier };
//# sourceMappingURL=subscription.service.d.ts.map