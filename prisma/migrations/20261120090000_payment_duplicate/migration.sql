-- Follow-ups to payments release 1: a second payment for something already
-- paid for (additive: one enum value).
ALTER TYPE "LedgerEntryType" ADD VALUE 'PAYMENT_DUPLICATE';
