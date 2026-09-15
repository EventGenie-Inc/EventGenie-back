import { type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';
import { type PaidSubscriptionTier } from './subscription-plans.config.js';
export interface SubscriptionPricingDto {
    currency: string;
    prices: Record<SubscriptionTier, Record<SubscriptionPeriod, number>>;
}
export interface SubscribeDto {
    tier: PaidSubscriptionTier;
    period: SubscriptionPeriod;
}
export interface ChangeTierDto {
    tier: PaidSubscriptionTier;
    period: SubscriptionPeriod;
}
export interface SubscriptionStatusDto {
    tier: SubscriptionTier;
    storedTier: SubscriptionTier;
    period: SubscriptionPeriod | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    pendingTierAfterPeriodEnd: SubscriptionTier | null;
    inGrace: boolean;
    graceDeadline: Date | null;
    card: {
        brand: string | null;
        last4: string | null;
        expMonth: string | null;
        expYear: string | null;
    } | null;
}
export interface ActivateSubscriptionInput {
    tier: PaidSubscriptionTier;
    period: SubscriptionPeriod;
    customerCode: string;
    subscriptionCode: string;
    emailToken: string;
    currentPeriodEnd: Date;
    authorizationCode?: string;
    cardBrand?: string;
    cardLast4?: string;
    cardExpMonth?: string;
    cardExpYear?: string;
}
export interface CheckoutResult {
    authorizationUrl: string;
}
export type ChangeTierResult = {
    outcome: 'accepted';
} | {
    outcome: 'scheduled';
    effectiveAt: Date | null;
};
//# sourceMappingURL=subscription.types.d.ts.map