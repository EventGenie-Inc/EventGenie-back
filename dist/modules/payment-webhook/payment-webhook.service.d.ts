import { type PaystackWebhookPayload, type WebhookProcessOutcome } from './payment-webhook.types.js';
export declare const paymentWebhookService: {
    isValidSignature: (rawBody: Buffer, signatureHeader: string | string[] | undefined) => boolean;
    process: (payload: PaystackWebhookPayload) => Promise<WebhookProcessOutcome>;
};
//# sourceMappingURL=payment-webhook.service.d.ts.map