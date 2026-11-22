import { type PaymentProduct } from '../payment-reconciliation/payment-mismatch.util.js';

// The payment a refund or chargeback is about, found by our reference or
// Paystack's transaction id.
export interface OriginalPayment {
  product: PaymentProduct;
  tenantId: string | null;
  eventId: string | null;
  relatedType: string;
  relatedId: string;
  reference: string | null;
  transactionId: string | null;
  // What was paid, in cents: a refund of at least this much is full.
  paidCents: number;
  currency: string;
  // The SUBSCRIPTION_CHARGE_SUCCEEDED ledger row, for a subscription.
  ledgerEntryId: string | null;
  // A subscription payment that granted nothing (PAYMENT_DUPLICATE or
  // PAYMENT_AMOUNT_MISMATCH): taking it back changes nothing.
  grantedNothing?: boolean;
}

// What taking a payment back did (REFUND_ISSUED / DISPUTE_LOST payload).
export type TakeBackEffect =
  | 'PASS_REMOVED'
  | 'PASS_LOWERED'
  | 'PASS_UNCHANGED'
  | 'SMS_CREDITS_REMOVED'
  | 'SUBSCRIPTION_ENDED'
  | 'SUBSCRIPTION_NOT_CURRENT_CHARGE'
  | 'NOTHING_WAS_GRANTED'
  | 'ALREADY_TAKEN_BACK'
  | 'TICKET_NOT_CHANGED'
  // A ticket order (ticket sales Round B): its valid tickets voided.
  | 'TICKETS_VOIDED'
  | 'PARTIAL_RECORDED_ONLY';

export interface TakeBackResult {
  effect: TakeBackEffect;
  details: Record<string, unknown>;
}
