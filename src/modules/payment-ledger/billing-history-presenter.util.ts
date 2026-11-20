import { type LedgerEntryType, type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';

// ─────────────────────────────────────────
//  BILLING HISTORY PRESENTER
//
//  The ledger is append-only and stores whatever a webhook or our own
//  code handed it — fine for a dispute, unreadable for a tenant admin
//  glancing at their billing history. This turns one entry into
//  (description, outcome) for display, tolerating whatever shape the
//  payload actually has (a raw Paystack webhook body for the *_SUCCEEDED/
//  *_FAILED cases, our own small object for the rest — see
//  subscription.service.ts's paymentLedgerService.record() call sites)
//  rather than assuming a fixed shape and throwing on a field that isn't
//  there.
//
//  Pure and synchronous, same shape as effective-tier.util.ts.
// ─────────────────────────────────────────

const TIER_LABEL: Record<SubscriptionTier, string> = { SPARK: 'Spark', CELEBRATE: 'Celebrate', ELEVATE: 'Elevate' };
const PERIOD_LABEL: Record<SubscriptionPeriod, string> = { MONTHLY: 'Monthly', ANNUAL: 'Annual' };

const isTier = (value: unknown): value is SubscriptionTier => typeof value === 'string' && value in TIER_LABEL;
const isPeriod = (value: unknown): value is SubscriptionPeriod => typeof value === 'string' && value in PERIOD_LABEL;

const planLabel = (tier: unknown, period: unknown): string | null => {
  if (!isTier(tier)) return null;
  return isPeriod(period) ? `${TIER_LABEL[tier]} (${PERIOD_LABEL[period]})` : TIER_LABEL[tier];
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

// UNDER_REVIEW: money came in but granted nothing (paid twice, or the wrong
// amount); the super admin refunds it or grants it by hand.
export type BillingHistoryOutcome = 'SUCCESS' | 'FAILED' | 'INFO' | 'UNDER_REVIEW';

// What an entry is, for the frontend to branch on (follow-ups to payments
// release 1): never the description's wording, which is for people.
//   CHARGE       a payment (outcome SUCCESS) or a failed one (FAILED)
//   REFUND       money returned from Paystack's dashboard
//   REVERSAL     a chargeback the customer's bank won: the money taken back
//   PLAN_CHANGE  a plan changed now, or a downgrade scheduled
//   CANCELLATION the subscription set to end at its period end
//   OTHER        anything else (never expected in billing history)
export type BillingHistoryKind = 'CHARGE' | 'REFUND' | 'REVERSAL' | 'PLAN_CHANGE' | 'CANCELLATION' | 'OTHER';
export type BillingHistoryProduct = 'SUBSCRIPTION' | 'EVENT_PASS' | 'SMS_BUNDLE';

export interface BillingHistoryDescription {
  description: string;
  outcome: BillingHistoryOutcome;
  kind: BillingHistoryKind;
  product: BillingHistoryProduct | null;
}

// The product a refund or reversal is about: the ledger row's relatedType
// (set from the original payment), else the payload's own `product`.
const PRODUCT_BY_RELATED_TYPE: Record<string, BillingHistoryProduct> = {
  Tenant: 'SUBSCRIPTION',
  EventPassPurchase: 'EVENT_PASS',
  EventSmsBundlePurchase: 'SMS_BUNDLE',
};
const PRODUCT_LABEL: Record<BillingHistoryProduct, string> = { SUBSCRIPTION: 'Subscription', EVENT_PASS: 'Event Pass', SMS_BUNDLE: 'SMS bundle' };
const isProduct = (value: unknown): value is BillingHistoryProduct => typeof value === 'string' && value in PRODUCT_LABEL;

const productOf = (type: LedgerEntryType, payload: Record<string, unknown>, relatedType: string | null): BillingHistoryProduct | null => {
  if (type.startsWith('SUBSCRIPTION_')) return 'SUBSCRIPTION';
  if (type.startsWith('EVENT_PASS_')) return 'EVENT_PASS';
  if (type.startsWith('SMS_BUNDLE_')) return 'SMS_BUNDLE';
  const byRelated = relatedType ? PRODUCT_BY_RELATED_TYPE[relatedType] : undefined;
  if (byRelated) return byRelated;
  return isProduct(payload['product']) ? payload['product'] : null;
};

const KIND_BY_TYPE: Partial<Record<LedgerEntryType, BillingHistoryKind>> = {
  SUBSCRIPTION_CHARGE_SUCCEEDED: 'CHARGE',
  SUBSCRIPTION_CHARGE_FAILED: 'CHARGE',
  EVENT_PASS_PURCHASE_SUCCEEDED: 'CHARGE',
  EVENT_PASS_PURCHASE_FAILED: 'CHARGE',
  SMS_BUNDLE_PURCHASE_SUCCEEDED: 'CHARGE',
  SMS_BUNDLE_PURCHASE_FAILED: 'CHARGE',
  PAYMENT_DUPLICATE: 'CHARGE',
  PAYMENT_AMOUNT_MISMATCH: 'CHARGE',
  REFUND_ISSUED: 'REFUND',
  DISPUTE_LOST: 'REVERSAL',
  SUBSCRIPTION_TIER_CHANGED: 'PLAN_CHANGE',
  SUBSCRIPTION_CANCELLED: 'CANCELLATION',
};

export const describeBillingHistoryEntry = (
  type: LedgerEntryType,
  rawPayload: unknown,
  relatedType: string | null = null
): BillingHistoryDescription => {
  const payload = asRecord(rawPayload);
  const product = productOf(type, payload, relatedType);
  const { description, outcome } = describeText(type, payload, product);
  return { description, outcome, kind: KIND_BY_TYPE[type] ?? 'OTHER', product };
};

const describeText = (
  type: LedgerEntryType,
  payload: Record<string, unknown>,
  product: BillingHistoryProduct | null
): { description: string; outcome: BillingHistoryOutcome } => {

  switch (type) {
    case 'SUBSCRIPTION_CHARGE_SUCCEEDED':
      return { description: 'Subscription payment', outcome: 'SUCCESS' };

    case 'SUBSCRIPTION_CHARGE_FAILED': {
      const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null;
      return {
        description: reason ? `Subscription payment failed: ${reason}` : 'Subscription payment failed',
        outcome: 'FAILED',
      };
    }

    case 'SUBSCRIPTION_TIER_CHANGED': {
      const from = asRecord(payload['from']);
      const to = payload['to'] !== undefined ? asRecord(payload['to']) : null;
      const pendingTo = payload['pendingTo'] !== undefined ? asRecord(payload['pendingTo']) : null;
      const fromLabel = planLabel(from['tier'], from['period']);

      if (to) {
        const toLabel = planLabel(to['tier'], to['period']);
        return {
          description: fromLabel && toLabel ? `Plan changed: ${fromLabel} → ${toLabel}` : 'Plan changed',
          outcome: 'SUCCESS',
        };
      }
      if (pendingTo) {
        const pendingLabel = planLabel(pendingTo['tier'], pendingTo['period']);
        return {
          description:
            fromLabel && pendingLabel ? `Downgrade scheduled: ${fromLabel} → ${pendingLabel}` : 'Downgrade scheduled',
          outcome: 'INFO',
        };
      }
      return { description: 'Plan changed', outcome: 'INFO' };
    }

    case 'SUBSCRIPTION_CANCELLED':
      return { description: 'Subscription cancelled', outcome: 'INFO' };

    case 'EVENT_PASS_PURCHASE_SUCCEEDED': {
      const isUpgrade = payload['isUpgrade'] === true;
      const passTier = typeof payload['passTier'] === 'string' ? payload['passTier'] : null;
      return {
        description: passTier ? `Event Pass ${isUpgrade ? 'upgraded to' : 'purchased'}: ${passTier}` : 'Event Pass purchased',
        outcome: 'SUCCESS',
      };
    }

    // Payments release 1: never Paystack's own text (payload.summary), which
    // is written for developers; that stays in the ledger for the super admin.
    case 'EVENT_PASS_PURCHASE_FAILED':
      return { description: 'Event Pass purchase failed', outcome: 'FAILED' };

    case 'REFUND_ISSUED':
      return { description: product ? `Refund: ${PRODUCT_LABEL[product]}` : 'Refund', outcome: 'INFO' };

    case 'PAYMENT_DUPLICATE':
      return { description: product ? `Paid twice: ${PRODUCT_LABEL[product]} (to be refunded)` : 'Paid twice (to be refunded)', outcome: 'UNDER_REVIEW' };

    case 'PAYMENT_AMOUNT_MISMATCH':
      return { description: product ? `Payment under review: ${PRODUCT_LABEL[product]}` : 'Payment under review', outcome: 'UNDER_REVIEW' };

    // A chargeback lost: the customer's bank took the payment back.
    case 'DISPUTE_LOST':
      return { description: product ? `Payment reversed: ${PRODUCT_LABEL[product]}` : 'Payment reversed', outcome: 'INFO' };

    case 'SMS_BUNDLE_PURCHASE_SUCCEEDED': {
      const smsCount = typeof payload['smsCount'] === 'number' ? payload['smsCount'] : null;
      return { description: smsCount ? `SMS bundle purchased: ${smsCount} credits` : 'SMS bundle purchased', outcome: 'SUCCESS' };
    }

    case 'SMS_BUNDLE_PURCHASE_FAILED':
      return { description: 'SMS bundle purchase failed', outcome: 'FAILED' };

    default:
      return { description: type, outcome: 'INFO' };
  }
};
