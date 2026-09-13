import { type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';
import { type PaidSubscriptionTier } from './subscription-plans.config.js';

export interface SubscribeDto {
  tier: PaidSubscriptionTier;
  period: SubscriptionPeriod;
}

export interface ChangeTierDto {
  tier: PaidSubscriptionTier;
  period: SubscriptionPeriod;
}

export interface SubscriptionStatusDto {
  // The tenant's CURRENT, EFFECTIVE tier — already resolved through
  // effective-tier.util.ts, never the raw stored value.
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

export type CheckoutResult = { authorizationUrl: string } | { failed: true; reason: string };

// changeTier's upgrade path charges an already-saved card directly —
// no redirect, so there is no authorizationUrl to hand back. The tier
// itself only flips once the resulting webhook confirms it (see
// subscription.service.ts's own comment), so `accepted` here means
// "Paystack took the request", not "the tenant is on the new plan yet".
export type ChangeTierResult =
  | { outcome: 'accepted' }
  | { outcome: 'scheduled'; effectiveAt: Date | null }
  | { outcome: 'failed'; reason: string };
