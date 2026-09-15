// Deliberately loose — this module has no ticket/subscription concepts
// (those handlers arrive with their own features), so it only knows the
// two fields every Paystack webhook payload has in common. Everything
// else in `data` is opaque here and stored verbatim in the ledger's
// payload column for whatever future handler ends up caring about it.
export interface PaystackWebhookPayload {
  event: string;
  data?: Record<string, unknown>;
}

export type WebhookProcessOutcome = 'processed' | 'duplicate';
