import { type LedgerEntryType, type Prisma } from '@prisma/client';

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
