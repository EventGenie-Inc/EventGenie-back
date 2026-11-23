import { amountCentsOf, currencyOf } from './paystack-payload.util.js';

// ─────────────────────────────────────────
//  THE CARD-UPDATE VERIFICATION CHARGE (fix/payments-go-live, ticket 8)
//
//  When a tenant replaces the card on its subscription through Paystack's
//  manage page (GET /api/subscriptions/update-card-link), Paystack charges the
//  new card R1 to tokenize it and refunds it at once. Neither is ours: not a
//  purchase, a renewal, a refund of the subscription, a duplicate or a ticket
//  order. This reads them from Paystack's own payloads, strictly.
//
//  The fields below are the real ones, read on 22 Nov 2026 from the dev
//  ledger (the refund webhooks' stored payloads) and from Paystack's test-mode
//  records of the two charges (GET /transaction/:id). Paystack's docs say the
//  charge happens and is refunded, but document none of these fields.
//
//  The charge (Paystack sent dev no charge.success for it; recognised in
//  case it ever does, and in the reconciliation's listing):
//    amount 100, currency "ZAR", channel "card",
//    metadata.transaction_type "update_card",
//    metadata.custom_fields[] { variable_name: "subscription_code", value: "SUB_…" },
//    plan {}, reference "T…" (Paystack's), status "reversed" once refunded.
//  Its refund (refund.pending, then refund.processed):
//    amount 100, currency "ZAR", customer {} (no customer code),
//    transaction_reference "T…" (the charge's),
//    merchant_note (and customer_note)
//      "Refund for update card charge [Subscription: SUB_…]".
//  A refund carries no channel: its strictness is the amount, the currency,
//  Paystack's note naming a subscription, and (the caller's part) no payment
//  of ours matching the refunded transaction.
// ─────────────────────────────────────────

export const CARD_VERIFICATION_AMOUNT_CENTS = 100;
export const CARD_VERIFICATION_CURRENCY = 'ZAR';

const REFUND_NOTE = /^Refund for update card charge \[Subscription: (SUB_[A-Za-z0-9]+)\]$/;
const SUBSCRIPTION_CODE = /^SUB_[A-Za-z0-9]+$/;

type Data = Record<string, unknown>;

const asRecord = (value: unknown): Data | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : null;

const isVerificationAmount = (data: Data): boolean =>
  amountCentsOf(data) === CARD_VERIFICATION_AMOUNT_CENTS && currencyOf(data) === CARD_VERIFICATION_CURRENCY;

export interface CardVerificationCharge {
  subscriptionCode: string;
  reference: string | null;
}

// The R1 charge itself: every one of the amount, the currency, the card
// channel, Paystack's update_card marker and the subscription it names.
export const cardVerificationChargeOf = (data: Data): CardVerificationCharge | null => {
  if (!isVerificationAmount(data)) return null;
  if (data['channel'] !== 'card') return null;
  const metadata = asRecord(data['metadata']);
  if (!metadata || metadata['transaction_type'] !== 'update_card') return null;
  const fields = Array.isArray(metadata['custom_fields']) ? (metadata['custom_fields'] as unknown[]) : [];
  const code = fields
    .map(asRecord)
    .find((f) => f?.['variable_name'] === 'subscription_code')?.['value'];
  if (typeof code !== 'string' || !SUBSCRIPTION_CODE.test(code)) return null;
  const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
  return { subscriptionCode: code, reference };
};

export interface CardVerificationRefund {
  subscriptionCode: string;
  // The refunded charge's reference (Paystack's "T…").
  transactionReference: string | null;
}

// Its refund: the amount, the currency and Paystack's own note, which names
// the subscription. Both notes, when present, must say the same.
export const cardVerificationRefundOf = (data: Data): CardVerificationRefund | null => {
  if (!isVerificationAmount(data)) return null;
  const merchant = typeof data['merchant_note'] === 'string' ? REFUND_NOTE.exec(data['merchant_note']) : null;
  if (!merchant) return null;
  const subscriptionCode = merchant[1]!;
  const customerNote = data['customer_note'];
  if (customerNote !== undefined && customerNote !== null) {
    const customer = typeof customerNote === 'string' ? REFUND_NOTE.exec(customerNote) : null;
    if (!customer || customer[1] !== subscriptionCode) return null;
  }
  const reference = data['transaction_reference'];
  return { subscriptionCode, transactionReference: typeof reference === 'string' && reference ? reference : null };
};
