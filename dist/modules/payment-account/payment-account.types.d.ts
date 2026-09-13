import { type PaystackSubaccountStatus } from '@prisma/client';
export interface SubmitSubaccountDto {
    businessName: string;
    settlementBank: string;
    accountNumber: string;
    /** Unverified declaration used only to let the organiser check what
     * they entered later; it is distinct from Paystack's businessName. */
    accountHolderName?: string;
    primaryContactEmail?: string;
    primaryContactName?: string;
    primaryContactPhone?: string;
}
export interface UpdateSubaccountDto {
    businessName?: string;
    settlementBank?: string;
    accountNumber?: string;
    accountHolderName?: string;
    primaryContactEmail?: string;
    primaryContactName?: string;
    primaryContactPhone?: string;
}
export interface SubaccountStatusDto {
    status: PaystackSubaccountStatus;
    readyToSell: boolean;
    subaccountCode: string | null;
    businessName: string | null;
    bankName: string | null;
    accountNumberLast4: string | null;
    accountHolderName: string | null;
    failureReason: string | null;
}
//# sourceMappingURL=payment-account.types.d.ts.map