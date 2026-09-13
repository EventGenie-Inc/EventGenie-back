import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { paymentLedgerRepository } from './payment-ledger.repository.js';
import { type RecordLedgerEntryInput, type BillingHistoryEntryDto } from './payment-ledger.types.js';
import { describeBillingHistoryEntry } from './billing-history-presenter.util.js';

type Db = Prisma.TransactionClient | typeof prisma;

// No business logic beyond the passthrough itself — recording a fact
// that already happened doesn't need validation or authorisation the
// way a mutation does. Kept as its own service (rather than calling the
// repository directly from callers) purely so every future caller
// depends on one seam, matching this codebase's model -> repository ->
// service -> router layering even where the service is this thin (see
// ticket-purchase.service.ts for the same shape).
export const paymentLedgerService = {
  record: (input: RecordLedgerEntryInput, db?: Db) => paymentLedgerRepository.create(input, db),

  // Presenter for the tenant-facing Billing History screen — strips
  // `payload` (a raw provider webhook body, never meant for the
  // browser) down to (description, outcome) via
  // describeBillingHistoryEntry, same "derive at read time, don't
  // persist a second copy" approach as effective-tier.util.ts.
  listBillingHistoryForTenant: async (tenantId: string): Promise<BillingHistoryEntryDto[]> => {
    const entries = await paymentLedgerRepository.findBillingHistoryByTenant(tenantId);
    return entries.map((entry) => {
      const { description, outcome } = describeBillingHistoryEntry(entry.type, entry.payload);
      return {
        id: entry.id,
        description,
        outcome,
        amountCents: entry.amountCents,
        currency: entry.currency,
        occurredAt: entry.occurredAt,
      };
    });
  },
};
