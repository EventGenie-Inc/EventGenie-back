import { type PaystackSubaccountStatus } from '@prisma/client';
export interface SubmitSubaccountDto {
    businessName: string;
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
    readyToSell: boolean;
    subaccountCode: string | null;
    businessName: string | null;
    bankName: string | null;
    failureReason: string | null;
}
//# sourceMappingURL=payment-account.types.d.ts.map