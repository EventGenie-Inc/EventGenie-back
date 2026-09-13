import { type LedgerEntryType } from '@prisma/client';
export type BillingHistoryOutcome = 'SUCCESS' | 'FAILED' | 'INFO';
export interface BillingHistoryDescription {
    description: string;
    outcome: BillingHistoryOutcome;
}
export declare const describeBillingHistoryEntry: (type: LedgerEntryType, rawPayload: unknown) => BillingHistoryDescription;
//# sourceMappingURL=billing-history-presenter.util.d.ts.map