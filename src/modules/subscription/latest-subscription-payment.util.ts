import { type PaymentLedgerEntry, type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';

// ─────────────────────────────────────────
//  THE LATEST SUBSCRIPTION PAYMENT (follow-ups to payments release 1)
//
//  What GET /api/subscriptions and POST /api/subscriptions/verify report as
//  `latestPayment`, so the billing callback can say what happened to the
//  payment, not only what plan the tenant is on. A subscription has no
//  purchase row of its own: the outcome is read from the ledger, newest
//  recorded attempt first, using the same statuses as a pass or bundle
//  purchase (PaymentAttemptStatus):
//
//    PENDING       started (a checkout, a plan change, or a plan change
//                  Paystack gave no clear answer to) and not yet confirmed
//    PAID          Paystack confirmed it
//    FAILED        Paystack refused it, or the checkout was left unpaid and
//                  cleared (the stale sweep, the sync)
//    REFUNDED      paid, then refunded in full from Paystack's dashboard
//    REVERSED      paid, then a chargeback lost
//    UNDER_REVIEW  paid the wrong amount, or paid twice (an abandoned
//                  checkout paid after a newer one): nothing granted, the
//                  super admin alerted to refund it
//
//  A partial refund leaves it PAID (nothing is taken back). Pure: the
//  caller reads the rows (payment-ledger.repository.ts).
// ─────────────────────────────────────────

export type LatestSubscriptionPaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'REVERSED' | 'UNDER_REVIEW';

export interface LatestSubscriptionPaymentDto {
  status: LatestSubscriptionPaymentStatus;
  amountCents: number;
  currency: string;
  // When it was paid (Paystack's paid_at) or recorded.
  occurredAt: Date;
  // When it was refunded or reversed, else null.
  takenBackAt: Date | null;
}

type Row = Pick<PaymentLedgerEntry, 'type' | 'amountCents' | 'currency' | 'occurredAt' | 'payload'>;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export const resolveLatestSubscriptionPayment = (
  row: Row | null,
  takeBacks: Row[],
  tenant: {
    subscriptionPendingReference: string | null;
    subscriptionNeedsSync: boolean;
    subscriptionTier: SubscriptionTier;
    subscriptionPeriod: SubscriptionPeriod | null;
    paystackSubscriptionCode: string | null;
  }
): LatestSubscriptionPaymentDto | null => {
  if (!row) return null;
  const base = { amountCents: row.amountCents, currency: row.currency, occurredAt: row.occurredAt, takenBackAt: null };

  // Newest first; a partial refund (full: false) takes nothing back.
  const takenBack = (whenKept: LatestSubscriptionPaymentStatus): LatestSubscriptionPaymentDto => {
    const full = takeBacks.find((t) => asRecord(t.payload)['full'] !== false);
    if (!full) return { ...base, status: whenKept };
    return { ...base, status: full.type === 'DISPUTE_LOST' ? 'REVERSED' : 'REFUNDED', takenBackAt: full.occurredAt };
  };

  switch (row.type) {
    case 'SUBSCRIPTION_CHARGE_SUCCEEDED':
      return takenBack('PAID');
    case 'SUBSCRIPTION_CHARGE_FAILED':
      return { ...base, status: 'FAILED' };
    // Paid the wrong amount, or paid twice: nothing granted, to be refunded.
    case 'PAYMENT_AMOUNT_MISMATCH':
    case 'PAYMENT_DUPLICATE':
      return takenBack('UNDER_REVIEW');
    case 'SUBSCRIPTION_CHARGE_INITIATED':
    case 'SUBSCRIPTION_CHARGE_UNCERTAIN': {
      if (tenant.subscriptionPendingReference || tenant.subscriptionNeedsSync) return { ...base, status: 'PENDING' };
      // No attempt pending any more. On the plan it asked for: the
      // subscription started and its charge's confirmation is still to come.
      // Otherwise it was left unpaid and cleared.
      const payload = asRecord(row.payload);
      const onThatPlan =
        tenant.paystackSubscriptionCode !== null &&
        payload['tier'] === tenant.subscriptionTier &&
        payload['period'] === tenant.subscriptionPeriod;
      return { ...base, status: onThatPlan ? 'PENDING' : 'FAILED' };
    }
    default:
      return null;
  }
};
