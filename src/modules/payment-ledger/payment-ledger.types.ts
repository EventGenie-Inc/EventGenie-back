import { type LedgerEntryType, type Prisma } from '@prisma/client';
import { type BillingHistoryOutcome } from './billing-history-presenter.util.js';

// Display-shaped row for the tenant-facing Billing History screen —
// deliberately NOT the raw PaymentLedgerEntry: never sends `payload`
// (a raw provider webhook body, or internal bookkeeping fields) to the
// browser, only what a tenant admin needs. See
// payment-ledger.service.ts's listBillingHistoryForTenant.
export interface BillingHistoryEntryDto {
  id: string;
  description: string;
  outcome: BillingHistoryOutcome;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

export interface RecordLedgerEntryInput {
  type: LedgerEntryType;
  amountCents: number;
  currency?: string;
  tenantId?: string | null;
  eventId?: string | null;
  paystackReference?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  // The verbatim provider payload — stored as-is for the day something
  // disputed needs settling. Prisma.InputJsonValue keeps this honest
  // (a JSON-serialisable value only) without resorting to `any`.
  payload?: Prisma.InputJsonValue | null;
  // Defaults to now() — override only when logging something learned
  // about after the fact (a delayed/retried webhook reporting an event
  // that happened earlier).
  occurredAt?: Date;
}
