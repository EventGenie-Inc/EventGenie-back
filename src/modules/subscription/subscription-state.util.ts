import { type SubscriptionPeriod, type SubscriptionTier } from '@prisma/client';
import { resolveEffectiveTier, type TenantSubscriptionState } from './effective-tier.util.js';
import { PENDING_CHECKOUT_REUSE_MS } from '../../shared/payments/pending-checkout.util.js';

// ─────────────────────────────────────────
//  THE SUBSCRIPTION'S STATE, IN ONE PLACE (STEERING "Payments", "A
//  subscription's state")
//
//  Two questions every subscription read and write asks, answered once:
//
//  - Has the tenant ENDED UP ON SPARK with no live subscription, while its
//    billing fields still describe one (a cancelled plan past its end, a
//    disabled one, a refund already disabled at Paystack, a custom tier
//    taken off over stale fields)? Then those fields are cleared:
//    `needsSettlingOnSpark` here, `settleOnSpark` in the repository. Nothing
//    may then claim a plan "ends".
//
//  - Can the tenant START a subscription now? `subscribeAvailability`, used
//    by GET /api/subscriptions (canSubscribe) and by subscribe itself, so
//    the frontend never works it out.
// ─────────────────────────────────────────

export interface SubscriptionStateFields extends TenantSubscriptionState {
  subscriptionPeriod: SubscriptionPeriod | null;
  subscriptionPendingTierAfterPeriodEnd: SubscriptionTier | null;
  paystackSubscriptionCode: string | null;
}

// A subscription Paystack may still charge: a code, not cancelled, on a
// paid tier. Subscribe's own test, and subscription.create's "live other".
export const hasLiveSubscription = (t: Pick<SubscriptionStateFields, 'paystackSubscriptionCode' | 'subscriptionCancelAtPeriodEnd' | 'subscriptionTier'>): boolean =>
  t.paystackSubscriptionCode !== null && !t.subscriptionCancelAtPeriodEnd && t.subscriptionTier !== 'SPARK';

// On Spark, with nothing live, and billing fields that still describe a
// subscription. Left alone:
//  - a live subscription (code, not cancelled, paid tier) whose grace or
//    hard stop has passed: Paystack may still renew it, and the sync
//    decides (a renewal moves the period end; Paystack's "cancelled" sets
//    cancelAtPeriodEnd, and then this settles it);
//  - a cancelled plan still inside its paid period (still on its tier);
//  - a refunded subscription waiting to be disabled at Paystack (Spark, a
//    code, not cancelled): its code is needed to disable it, and is cleared
//    when that's done (clearSubscriptionCodes).
// A pending checkout (subscriptionPending*) is the tenant's own next
// purchase, never touched here.
export const needsSettlingOnSpark = (t: SubscriptionStateFields, now: Date = new Date()): boolean => {
  if (hasLiveSubscription(t)) return false;
  if (resolveEffectiveTier(t, now) !== 'SPARK') return false;
  if (t.subscriptionTier === 'SPARK' && t.paystackSubscriptionCode !== null && !t.subscriptionCancelAtPeriodEnd) return false;
  return (
    t.subscriptionCancelAtPeriodEnd ||
    t.subscriptionPendingTierAfterPeriodEnd !== null ||
    t.subscriptionTier !== 'SPARK' ||
    t.subscriptionPeriod !== null ||
    t.subscriptionCurrentPeriodEnd !== null ||
    t.subscriptionGraceStartedAt !== null ||
    t.paystackSubscriptionCode !== null
  );
};

export type CannotSubscribeReason =
  // A subscription Paystack may still charge (to change plan: change-tier;
  // a failing card: the update-card link).
  | 'SUBSCRIPTION_ACTIVE'
  // A checkout started within the last 30 minutes: continue it (the same
  // plan hands back its link), or wait for it to end.
  | 'CHECKOUT_PENDING'
  // A plan change being confirmed.
  | 'PLAN_CHANGE_PENDING';

// A custom tier is no reason not to: a trial converts by subscribing (its
// subscription.create takes the tenant off the custom tier).
export const subscribeAvailability = (
  t: Pick<SubscriptionStateFields, 'paystackSubscriptionCode' | 'subscriptionCancelAtPeriodEnd' | 'subscriptionTier'> & {
    subscriptionPendingReference: string | null;
    subscriptionPendingStartedAt: Date | null;
  },
  now: Date = new Date()
): { canSubscribe: boolean; reason: CannotSubscribeReason | null } => {
  const no = (reason: CannotSubscribeReason) => ({ canSubscribe: false, reason });
  if (hasLiveSubscription(t)) return no('SUBSCRIPTION_ACTIVE');
  // A pending attempt older than the reuse window no longer holds anything
  // (subscribe's claim takes over from it).
  const pendingHolds =
    t.subscriptionPendingReference !== null &&
    t.subscriptionPendingStartedAt !== null &&
    now.getTime() - t.subscriptionPendingStartedAt.getTime() < PENDING_CHECKOUT_REUSE_MS;
  if (pendingHolds) return no(t.subscriptionPendingReference!.startsWith('upg_') ? 'PLAN_CHANGE_PENDING' : 'CHECKOUT_PENDING');
  return { canSubscribe: true, reason: null };
};
