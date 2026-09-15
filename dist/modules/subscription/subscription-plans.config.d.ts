import { type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';
export declare const SUBSCRIPTION_PRICES_CENTS: Record<SubscriptionTier, Record<SubscriptionPeriod, number>>;
export type PaidSubscriptionTier = 'CELEBRATE' | 'ELEVATE';
export declare const isPaidTier: (tier: SubscriptionTier) => tier is PaidSubscriptionTier;
export declare const getPlanCode: (tier: PaidSubscriptionTier, period: SubscriptionPeriod) => string;
export declare const resolveTierAndPeriodFromPlanCode: (planCode: string) => {
    tier: PaidSubscriptionTier;
    period: SubscriptionPeriod;
} | null;
//# sourceMappingURL=subscription-plans.config.d.ts.map