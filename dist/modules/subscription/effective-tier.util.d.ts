import { type SubscriptionTier } from '@prisma/client';
export declare const TIER_RANK: Record<SubscriptionTier, number>;
export interface TenantSubscriptionState {
    subscriptionTier: SubscriptionTier;
    subscriptionCancelAtPeriodEnd: boolean;
    subscriptionCurrentPeriodEnd: Date | null;
    subscriptionGraceStartedAt: Date | null;
}
export declare const resolveEffectiveTier: (tenant: TenantSubscriptionState, now?: Date) => SubscriptionTier;
export declare const isWithinGraceOrPaidPeriod: (tenant: TenantSubscriptionState, now?: Date) => boolean;
export declare const withEffectiveTier: <T extends TenantSubscriptionState>(tenant: T) => T;
//# sourceMappingURL=effective-tier.util.d.ts.map