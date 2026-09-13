export declare class PaystackApiError extends Error {
    paystackMessage: string;
    httpStatus: number;
    constructor(paystackMessage: string, httpStatus: number);
}
export interface InitializeTransactionParams {
    email: string;
    amountCents: number;
    currency?: string;
    reference?: string;
    callbackUrl?: string;
    channels?: string[];
    subaccount?: string;
    transactionChargeCents?: number;
    bearer?: 'account' | 'subaccount';
    plan?: string;
    metadata?: Record<string, unknown>;
}
export interface InitializeTransactionResult {
    authorizationUrl: string;
    accessCode: string;
    reference: string;
}
export declare const initializeTransaction: (params: InitializeTransactionParams) => Promise<InitializeTransactionResult>;
interface PaystackTransactionVerifyData {
    reference: string;
    status: string;
    amount: number;
    currency: string;
    gateway_response: string;
    paid_at: string | null;
    channel: string | null;
    customer?: {
        email?: string;
    };
    authorization?: {
        authorization_code?: string;
    };
    [key: string]: unknown;
}
export interface VerifyTransactionResult {
    reference: string;
    status: string;
    amountCents: number;
    currency: string;
    gatewayResponse: string;
    paidAt: string | null;
    channel: string | null;
    customerEmail: string | null;
    authorizationCode: string | null;
    raw: PaystackTransactionVerifyData;
}
export declare const verifyTransaction: (reference: string) => Promise<VerifyTransactionResult>;
interface PaystackSubaccountData {
    subaccount_code: string;
    business_name: string;
    settlement_bank: string;
    account_number: string;
    active: boolean;
    percentage_charge: number;
    [key: string]: unknown;
}
export interface CreateSubaccountParams {
    businessName: string;
    settlementBank: string;
    accountNumber: string;
    percentageCharge?: number;
    description?: string;
    primaryContactEmail?: string;
    primaryContactName?: string;
    primaryContactPhone?: string;
}
export interface SubaccountResult {
    subaccountCode: string;
    businessName: string;
    settlementBank: string;
    accountNumber: string;
    active: boolean;
    raw: PaystackSubaccountData;
}
export declare const createSubaccount: (params: CreateSubaccountParams) => Promise<SubaccountResult>;
export declare const updateSubaccount: (subaccountCode: string, params: Partial<CreateSubaccountParams> & {
    active?: boolean;
}) => Promise<SubaccountResult>;
export declare const getSubaccount: (subaccountCode: string) => Promise<SubaccountResult>;
export interface PaystackBank {
    name: string;
    code: string;
}
export declare const listBanks: (params?: {
    country?: string;
    currency?: string;
}) => Promise<PaystackBank[]>;
export declare const verifyWebhookSignature: (rawBody: Buffer | string, signatureHeader: string | string[] | undefined) => boolean;
export interface CreatePlanParams {
    name: string;
    amountCents: number;
    interval: string;
    currency?: string;
    description?: string;
}
export interface PaystackPlan {
    planCode: string;
    name: string;
    amountCents: number;
    interval: string;
    currency: string;
}
export declare const createPlan: (params: CreatePlanParams) => Promise<PaystackPlan>;
export declare const listPlans: () => Promise<PaystackPlan[]>;
export interface CreateSubscriptionParams {
    customerCode: string;
    planCode: string;
    authorizationCode?: string;
}
export interface PaystackSubscription {
    subscriptionCode: string;
    emailToken: string;
    nextPaymentDate: string;
    status: string;
    customerCode: string | null;
    planCode: string | null;
    authorizationCode: string | null;
    cardLast4: string | null;
    cardBrand: string | null;
    cardExpMonth: string | null;
    cardExpYear: string | null;
}
export declare const createSubscription: (params: CreateSubscriptionParams) => Promise<PaystackSubscription>;
export declare const disableSubscription: (subscriptionCode: string, emailToken: string) => Promise<void>;
export declare const getSubscription: (subscriptionCode: string) => Promise<PaystackSubscription>;
export declare const generateSubscriptionManageLink: (subscriptionCode: string) => Promise<string>;
export {};
//# sourceMappingURL=paystack.client.d.ts.map