import * as paystackClient from '../../shared/payments/paystack.client.js';
import { type SubmitSubaccountDto, type UpdateSubaccountDto, type SubaccountStatusDto } from './payment-account.types.js';
export declare const paymentAccountService: {
    getStatus: (tenantId: string) => Promise<SubaccountStatusDto>;
    listBanks: () => Promise<paystackClient.PaystackBank[]>;
    submit: (tenantId: string, data: SubmitSubaccountDto) => Promise<SubaccountStatusDto>;
    update: (tenantId: string, data: UpdateSubaccountDto) => Promise<SubaccountStatusDto>;
};
//# sourceMappingURL=payment-account.service.d.ts.map