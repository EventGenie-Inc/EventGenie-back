export type PaymentAlertKind =
  | 'DISPUTE'
  | 'AMOUNT_MISMATCH'
  | 'UNHANDLED_WEBHOOK'
  | 'RECONCILIATION'
  | 'DUPLICATE_SUBSCRIPTION'
  | 'REFUND'
  | 'SYNC';

export interface PaymentAlertInput {
  kind: PaymentAlertKind;
  // Short, plain: "Chargeback opened on an Event Pass".
  subject: string;
  // One or two sentences: what happened and what to do.
  lines: string[];
  // "Reference: pass_…", "Amount: R399.00", "Tenant: <id>".
  facts?: string[];
}
