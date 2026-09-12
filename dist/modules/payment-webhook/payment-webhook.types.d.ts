export interface PaystackWebhookPayload {
    event: string;
    data?: Record<string, unknown>;
}
export type WebhookProcessOutcome = 'processed' | 'duplicate';
//# sourceMappingURL=payment-webhook.types.d.ts.map