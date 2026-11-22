import { type PaystackSubaccountStatus, type PayoutAccountChangeKind, type PayoutAccountChangeStatus } from '@prisma/client';

// ─────────────────────────────────────────
//  PAYOUT ACCOUNT (one per organisation; ticket sales Round A, 2026-11)
//
//  POST /api/payments/subaccount  — the first setup (takes effect at once)
//  PUT  /api/payments/subaccount  — a change (takes effect after 24 hours)
//  Same body for both. Every field arrives from a request body, so each is
//  checked at runtime (payment-account.service.ts's parseAccountInput).
// ─────────────────────────────────────────

export interface PayoutAccountInput {
  // Bank CODE from GET /api/payments/subaccount/banks.
  settlementBank?: unknown;
  // Digits; spaces and hyphens are ignored. Sent to Paystack and dropped:
  // only its last 4 digits are kept.
  accountNumber?: unknown;
  accountHolderName?: unknown;
  // Optional: the name Paystack shows for the subaccount. Defaults to the
  // account holder's name.
  businessName?: unknown;
}

// Kept for older callers' type imports.
export type SubmitSubaccountDto = PayoutAccountInput;
export type UpdateSubaccountDto = PayoutAccountInput;

// NONE           no account and nothing being set up.
// SETUP_PENDING  the first account is being confirmed with Paystack.
// ACTIVE         an account is in use and no change is waiting.
// CHANGE_PENDING an account is in use and a new one is waiting for its
//                effectiveAt (or still being confirmed with Paystack).
export type PayoutAccountState = 'NONE' | 'SETUP_PENDING' | 'ACTIVE' | 'CHANGE_PENDING';

export interface PendingPayoutChangeDto {
  id: string;
  kind: PayoutAccountChangeKind;
  status: Extract<PayoutAccountChangeStatus, 'CREATING' | 'PENDING'>;
  bankName: string;
  accountNumberLast4: string;
  accountHolderName: string;
  requestedAt: Date;
  // When it becomes the account sales are paid into.
  effectiveAt: Date;
  // false while Paystack's answer about the new subaccount is still unclear
  // (it is being confirmed; nothing changes until it is).
  creationConfirmed: boolean;
}

export interface SubaccountStatusDto {
  state: PayoutAccountState;
  // The current account's Paystack status: NOT_STARTED, PENDING (Paystack
  // hasn't activated it), ACTIVE, FAILED (the first setup was refused).
  status: PaystackSubaccountStatus;
  // Whether sales can be paid out right now (status ACTIVE). Derived.
  readyToSell: boolean;
  subaccountCode: string | null;
  businessName: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  accountHolderName: string | null;
  // When the current account took effect (null for one set up before
  // 2026-11).
  activeSince: Date | null;
  // Why the first setup was refused, in our words; null otherwise.
  failureReason: string | null;
  pendingChange: PendingPayoutChangeDto | null;
}

// POST and PUT answer with the status, plus exactly what was submitted, for
// the organiser to read back: never the full account number.
export interface PayoutSubmissionDto extends SubaccountStatusDto {
  submitted: {
    changeId: string;
    kind: PayoutAccountChangeKind;
    bankName: string;
    accountNumberLast4: string;
    accountHolderName: string;
    effectiveAt: Date;
    creationConfirmed: boolean;
  };
}
