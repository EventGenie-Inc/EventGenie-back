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
  | 'UNEXPECTED_AMOUNT';

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
