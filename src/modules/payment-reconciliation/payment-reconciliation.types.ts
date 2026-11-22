export type MismatchSource = 'RECONCILIATION' | 'WEBHOOK';

export type MismatchKind =
  // Paystack has a successful payment the ledger has no success for.
  | 'PAYSTACK_ONLY'
  // The ledger has a success Paystack doesn't confirm.
  | 'LEDGER_ONLY'
  | 'AMOUNT_DIFFERS'
  | 'CURRENCY_DIFFERS'
  // Paystack processed a refund the ledger has no REFUND_ISSUED for.
  | 'REFUND_NOT_RECORDED'
  // A webhook's success for an amount or currency other than expected.
  | 'UNEXPECTED_AMOUNT'
  // A second payment for something already paid for: nothing extra
  // granted, to be refunded (payment-mismatch.util.ts's recordDuplicatePayment).
  | 'DUPLICATE_PAYMENT'
  // Ticket sales Round B: a ticket payment whose subaccount or split wasn't
  // its order's (the order is UNDER_REVIEW, no tickets issued).
  | 'SPLIT_MISMATCH'
  // Ticket sales Round B: Paystack's actual fee on a ticket order was above
  // e-velope's charge less the commission (e-velope lost money on it).
  | 'NEGATIVE_NET';

export interface CreateMismatchInput {
  runId?: string | null;
  source: MismatchSource;
  kind: MismatchKind;
  paystackReference?: string | null;
  paystackTransactionId?: string | null;
  tenantId?: string | null;
  eventId?: string | null;
  expectedAmountCents?: number | null;
  actualAmountCents?: number | null;
  currency?: string | null;
  details?: Record<string, unknown>;
}

export interface ReconciliationResult {
  runDate: string;
  paystackSuccessCount: number;
  ledgerSuccessCount: number;
  refundCount: number;
  settlementCount: number;
  settledTotalCents: number;
  mismatches: CreateMismatchInput[];
}

// Super admin views.
export interface MismatchDto {
  id: string;
  source: string;
  kind: string;
  paystackReference: string | null;
  paystackTransactionId: string | null;
  tenantId: string | null;
  eventId: string | null;
  expectedAmountCents: number | null;
  actualAmountCents: number | null;
  currency: string | null;
  details: unknown;
  runDate: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ReconciliationRunDto {
  id: string;
  runDate: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  mismatchCount: number;
  summary: unknown;
}

export interface LedgerEntryDto {
  id: string;
  type: string;
  amountCents: number;
  currency: string;
  tenantId: string | null;
  eventId: string | null;
  paystackReference: string | null;
  paystackTransactionId: string | null;
  relatedType: string | null;
  relatedId: string | null;
  payload: unknown;
  occurredAt: Date;
  createdAt: Date;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
