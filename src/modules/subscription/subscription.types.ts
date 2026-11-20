import { type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';
import { type PaidSubscriptionTier } from './subscription-plans.config.js';
import { type TenantCustomTierView } from '../custom-tier/custom-tier.types.js';
import { type LatestSubscriptionPaymentDto } from './latest-subscription-payment.util.js';

// The single source of truth for what each tier+period costs, exposed
// read-only — see subscription.service.ts's getPricing for why this
// exists (the frontend had no way to show a price without hardcoding
// its own copy of SUBSCRIPTION_PRICES_CENTS, and two copies of a price
// drift silently).
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
  // Custom tiers: the tenant's custom tier while it is current (its name,
  // description, end date; null = no end), else null. When set, it IS the
  // plan (tier below is what the tenant falls back to), invoiced outside
  // the app: nothing here asks for payment.
  customTier: TenantCustomTierView | null;
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
  // Payments release 1: a checkout or plan change started and not yet
  // confirmed by Paystack (null when none). The billing callback page polls
  // GET /api/subscriptions, or calls POST /api/subscriptions/verify.
  pendingChange: { tier: SubscriptionTier; period: SubscriptionPeriod; startedAt: Date | null } | null;
  // The outcome of the latest subscription payment (null when there has
  // never been one): PENDING, PAID, FAILED, REFUNDED, REVERSED or
  // UNDER_REVIEW (latest-subscription-payment.util.ts). The billing callback
  // says what happened from this, not from the tier.
  latestPayment: LatestSubscriptionPaymentDto | null;
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

// A failed checkout initialization is no longer a value in this union —
// it's a thrown HttpError (422 for a real Paystack rejection, 500 for
// a server misconfiguration like a missing plan code) so the caller
// gets a real status code instead of a 200 carrying bad news. See
// subscription.service.ts's subscribe().
// reused: a pending checkout for the same plan was handed back instead of
// a new one being started (payments release 1).
export interface CheckoutResult {
  authorizationUrl: string;
  reused: boolean;
}

// changeTier's upgrade path charges an already-saved card directly —
// no redirect, so there is no authorizationUrl to hand back. The tier
// itself only flips once the resulting webhook confirms it (see
// subscription.service.ts's own comment), so `accepted` here means
// "Paystack took the request", not "the tenant is on the new plan yet".
// Same as CheckoutResult above: a failed upgrade is a thrown HttpError,
// not an `{outcome: 'failed'}` value.
// pending_confirmation (payments release 1): Paystack gave no clear answer
// to the new subscription; it may have started. Recorded as uncertain and
// re-checked by the subscription sync; never reported as failed.
export type ChangeTierResult =
  | { outcome: 'accepted' }
  | { outcome: 'pending_confirmation' }
  | { outcome: 'scheduled'; effectiveAt: Date | null };
