import { DEFAULT_CURRENCY } from './money.util.js';

// ─────────────────────────────────────────
//  READING A PAYSTACK PAYLOAD (payments release 1)
//
//  A webhook's `data`, or a verify result's raw body, read the same way
//  everywhere: Paystack's transaction id, when the money moved (paid_at),
//  and whether the amount and currency are what we expected. Nothing here
//  knows a feature; it reads Paystack's own field names only.
// ─────────────────────────────────────────

type Data = Record<string, unknown>;

const asRecord = (value: unknown): Data | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : null;

// Paystack's own transaction id (data.id), as a string.
export const transactionIdOf = (data: Data): string | null => {
  const id = data['id'];
  return typeof id === 'number' || (typeof id === 'string' && id) ? String(id) : null;
};

// When the money moved, per Paystack: paid_at (or paidAt, which some
// payloads use), else transaction_date. Undefined when none parses, so the
// ledger falls back to "now".
export const paidAtOf = (data: Data): Date | undefined => {
  for (const key of ['paid_at', 'paidAt', 'transaction_date']) {
    const value = data[key];
    if (typeof value === 'string') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return undefined;
};

export const amountCentsOf = (data: Data): number | null => {
  const amount = data['amount'];
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
};

export const currencyOf = (data: Data): string | null => {
  const currency = data['currency'];
  return typeof currency === 'string' && currency ? currency.toUpperCase() : null;
};

export type AmountCheck =
  | { ok: true }
  | { ok: false; expectedCents: number; actualCents: number | null; expectedCurrency: string; actualCurrency: string | null };

// The one check every confirmation makes: Paystack's amount equals what we
// asked for, in the currency we asked for. A missing amount or currency is a
// mismatch, not a pass: a success we can't check is not granted.
export const checkAmount = (data: Data, expectedCents: number, expectedCurrency: string = DEFAULT_CURRENCY): AmountCheck => {
  const actualCents = amountCentsOf(data);
  const actualCurrency = currencyOf(data);
  if (actualCents === expectedCents && actualCurrency === expectedCurrency.toUpperCase()) return { ok: true };
  return { ok: false, expectedCents, actualCents, expectedCurrency, actualCurrency };
};

// ─────────────────────────────────────────
//  REFUNDS AND DISPUTES — which payment they are about
//
//  Paystack's refund and dispute payloads name the original transaction in
//  more than one way across its documentation and SDKs (transaction_reference;
//  transaction as an object with id and reference; transaction as a bare
//  id). Every shape is read; the reference is preferred (it's ours for a
//  first charge), the transaction id is the fallback (a renewal's reference
//  is Paystack's, but its id is on our ledger row).
// ─────────────────────────────────────────
export interface OriginalPaymentKeys {
  reference: string | null;
  transactionId: string | null;
}

export const originalPaymentOf = (data: Data): OriginalPaymentKeys => {
  const transaction = data['transaction'];
  const transactionObject = asRecord(transaction);
  const referenceCandidates = [
    data['transaction_reference'],
    transactionObject?.['reference'],
  ];
  const reference = referenceCandidates.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
  const idCandidate =
    transactionObject?.['id'] ??
    (typeof transaction === 'number' || typeof transaction === 'string' ? transaction : undefined);
  const transactionId =
    typeof idCandidate === 'number' || (typeof idCandidate === 'string' && idCandidate) ? String(idCandidate) : null;
  return { reference, transactionId };
};

// A dispute's or refund's own amount: refund_amount (disputes), else amount.
export const adjustmentAmountOf = (data: Data): number | null => {
  for (const key of ['refund_amount', 'amount']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const transaction = asRecord(data['transaction']);
  const nested = transaction?.['amount'];
  return typeof nested === 'number' ? nested : null;
};
