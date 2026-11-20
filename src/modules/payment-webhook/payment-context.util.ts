import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { type WebhookContext } from './payment-webhook.types.js';

// Prisma's defaults (maxWait ~2s, timeout ~5s) are tuned for a warm pool;
// a serverless Postgres connection's cold start alone can exceed both (see
// rsvp.service.ts's transaction options). Shared by every payment
// transaction.
export const PAYMENT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

export type PostCommitWork = () => Promise<void>;

// Runs queued post-commit work in order. Never throws: each failure is
// logged and reported, and the next piece still runs. Whatever a failed
// piece was for is caught later (the subscription sync, the reconciliation).
export const runPostCommit = async (work: PostCommitWork[]): Promise<void> => {
  for (const piece of work) {
    try {
      await piece();
    } catch (err) {
      console.error('[payments] post-commit work failed:', err);
      reportError(err);
    }
  }
};

// The same context a webhook handler gets, for a confirmation that comes
// from somewhere else: a verify fallback (the organiser's callback page),
// the stale sweep, the subscription sync. `data` is Paystack's own payload
// for the transaction (a verify result's raw body has the same fields as a
// charge.success webhook's data).
export const withPaymentContext = async <T>(
  event: string,
  data: Record<string, unknown>,
  fn: (ctx: WebhookContext) => Promise<T>
): Promise<T> => {
  const work: PostCommitWork[] = [];
  const result = await prisma.$transaction(
    (tx: Prisma.TransactionClient) =>
      fn({ tx, event, data, payload: data as unknown as Prisma.InputJsonValue, after: (piece) => work.push(piece) }),
    PAYMENT_TRANSACTION_OPTIONS
  );
  await runPostCommit(work);
  return result;
};
