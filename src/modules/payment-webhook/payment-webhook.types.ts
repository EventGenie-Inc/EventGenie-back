import { type Prisma } from '@prisma/client';

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

// ─────────────────────────────────────────
//  WEBHOOK CONTEXT (payments release 1)
//
//  What every handler gets: the webhook's own transaction (the dedupe row
//  commits with the handler's effect, or neither does), the payload, and
//  `after`: work that must wait until that transaction has committed and
//  must not sit inside it: a Paystack call (disabling a subscription,
//  fetching a renewal's new period end) or an alert email. Post-commit work
//  never throws back into the webhook: it logs, and anything it couldn't do
//  is left for the subscription sync (Tenant.subscriptionNeedsSync).
// ─────────────────────────────────────────
export interface WebhookContext {
  tx: Prisma.TransactionClient;
  event: string;
  data: Record<string, unknown>;
  payload: Prisma.InputJsonValue;
  after: (work: () => Promise<void>) => void;
}

export interface HandlerResult {
  claimed: boolean;
}
