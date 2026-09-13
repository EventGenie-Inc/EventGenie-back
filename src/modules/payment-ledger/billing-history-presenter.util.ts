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

export type BillingHistoryOutcome = 'SUCCESS' | 'FAILED' | 'INFO';

export interface BillingHistoryDescription {
  description: string;
  outcome: BillingHistoryOutcome;
}

export const describeBillingHistoryEntry = (type: LedgerEntryType, rawPayload: unknown): BillingHistoryDescription => {
  const payload = asRecord(rawPayload);

  switch (type) {
    case 'SUBSCRIPTION_CHARGE_SUCCEEDED':
      return { description: 'Subscription payment', outcome: 'SUCCESS' };

    case 'SUBSCRIPTION_CHARGE_FAILED': {
      const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null;
      return {
        description: reason ? `Subscription payment failed — ${reason}` : 'Subscription payment failed',
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

    default:
      return { description: type, outcome: 'INFO' };
  }
};
