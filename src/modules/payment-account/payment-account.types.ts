import { type PaystackSubaccountStatus } from '@prisma/client';

export interface SubmitSubaccountDto {
  businessName: string;
  // Bank CODE (from GET /api/payments/subaccount/banks), not a bank name.
  settlementBank: string;
  accountNumber: string;
  primaryContactEmail?: string;
  primaryContactName?: string;
  primaryContactPhone?: string;
}

export interface UpdateSubaccountDto {
  businessName?: string;
  settlementBank?: string;
  accountNumber?: string;
  primaryContactEmail?: string;
  primaryContactName?: string;
  primaryContactPhone?: string;
}

export interface SubaccountStatusDto {
  status: PaystackSubaccountStatus;
  // What the frontend actually gates paid event creation on — derived
  // from status, never stored separately (same "derive, don't store"
  // rule as the payment ledger).
  readyToSell: boolean;
  subaccountCode: string | null;
  businessName: string | null;
  bankName: string | null;
  failureReason: string | null;
}
