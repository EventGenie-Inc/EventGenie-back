import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { verifyWebhookSignature } from '../../shared/payments/paystack.client.js';
import { DEFAULT_CURRENCY } from '../../shared/payments/money.util.js';
import { paymentWebhookRepository } from './payment-webhook.repository.js';
import { isDuplicateWebhookEvent } from './payment-webhook-idempotency.util.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { ticketPurchaseService } from '../ticket-purchase/ticket-purchase.service.js';
import { type PaystackWebhookPayload, type WebhookProcessOutcome } from './payment-webhook.types.js';

// Building block for the dedupe key AND the ledger's paystackReference —
// Paystack's own transaction id (data.id) is preferred when present
// since it's stable and numeric; data.reference is the fallback for
// event types that carry a reference but no id.
const extractReference = (data: Record<string, unknown>): string | null => {
  const id = data['id'];
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  const reference = data['reference'];
  if (typeof reference === 'string') return reference;
  return null;
};

const extractAmountCents = (data: Record<string, unknown>): number => {
  const amount = data['amount'];
  return typeof amount === 'number' ? amount : 0;
};

const extractCurrency = (data: Record<string, unknown>): string => {
  const currency = data['currency'];
  return typeof currency === 'string' ? currency : DEFAULT_CURRENCY;
};

// Distinct from extractReference above on purpose: this is specifically
// Paystack's `data.reference` string — the exact value a feature module
// chose and passed as `reference` to initializeTransaction (e.g.
// TicketPurchase.paymentRef). data.id is a Paystack-internal numeric id
// that no feature module ever stores, so preferring it here (the way
// extractReference does for generic dedup purposes) would make every
// charge.success/failed dispatch fail to find its purchase — confirmed
// the hard way in testing before this comment existed.
const extractMerchantReference = (data: Record<string, unknown>): string | null => {
  const reference = data['reference'];
  return typeof reference === 'string' ? reference : null;
};

// Routes a signature-verified, first-seen delivery to whichever feature
// actually owns it — ticketing today, subscription billing later. Runs
// INSIDE the same transaction as the idempotency-guard insert (the
// caller's `tx`), not a fresh one: if this webhook's business effect
// and the "we've seen this delivery" marker didn't commit together, a
// crash between them would mark the delivery seen without the
// confirmation ever having happened — and a redelivery would then be
// silently skipped as a duplicate, losing it forever. Falls through to
// the generic WEBHOOK_EVENT_UNHANDLED log for any event type nothing
// claims, AND for a charge.success/failed whose reference doesn't match
// any ticket purchase (a future subscription charge will emit the same
// event names) — 'not_found' from either ticket-purchase function means
// exactly that, not an error.
const dispatchToFeatureHandler = async (
  tx: Prisma.TransactionClient,
  event: string,
  data: Record<string, unknown>,
  jsonPayload: Prisma.InputJsonValue
): Promise<boolean> => {
  const merchantReference = extractMerchantReference(data);
  if (!merchantReference) return false;

  if (event === 'charge.success') {
    const result = await ticketPurchaseService.confirmPaymentWithinTransaction(tx, merchantReference, jsonPayload);
    return result.outcome !== 'not_found';
  }

  if (event === 'charge.failed') {
    const result = await ticketPurchaseService.failPaymentWithinTransaction(tx, merchantReference, jsonPayload);
    return result.outcome !== 'not_found';
  }

  return false;
};

// ─────────────────────────────────────────
//  PAYMENT WEBHOOK SERVICE
//
//  Establishes the mechanism — verification, idempotency, logging — AND
//  dispatches to ticketing's confirm/fail handlers above. Subscription
//  billing will add its own branch to dispatchToFeatureHandler when it
//  exists. Any event type (or unmatched reference) nothing claims is
//  still logged as WEBHOOK_EVENT_UNHANDLED so nothing arriving is ever
//  silently dropped.
// ─────────────────────────────────────────
export const paymentWebhookService = {
  // Deliberately synchronous and side-effect-free — called by the
  // router BEFORE anything else touches the request. An invalid result
  // here must lead to an immediate rejection with zero database access,
  // which is why this function itself never queries Prisma.
  isValidSignature: (rawBody: Buffer, signatureHeader: string | string[] | undefined): boolean =>
    verifyWebhookSignature(rawBody, signatureHeader),

  // Only ever called once isValidSignature has returned true. Writes the
  // idempotency-guard row and the ledger row together, in one
  // transaction, so a delivery can never be marked "seen" without a
  // matching audit entry, or vice versa.
  process: async (payload: PaystackWebhookPayload): Promise<WebhookProcessOutcome> => {
    const data = payload.data ?? {};
    const reference = extractReference(data);
    const dedupeKey = `${payload.event}:${reference ?? ''}`;
    const amountCents = extractAmountCents(data);
    const currency = extractCurrency(data);
    const jsonPayload = payload as unknown as Prisma.InputJsonValue;

    try {
      await prisma.$transaction(async (tx) => {
        await paymentWebhookRepository.markProcessed(payload.event, dedupeKey, tx);

        const claimed = await dispatchToFeatureHandler(tx, payload.event, data, jsonPayload);
        if (!claimed) {
          await paymentLedgerRepository.create(
            {
              type: 'WEBHOOK_EVENT_UNHANDLED',
              amountCents,
              currency,
              paystackReference: reference,
              relatedType: 'webhook',
              relatedId: payload.event,
              payload: jsonPayload,
            },
            tx
          );
        }
      }, {
        // Prisma's defaults (maxWait ~2s, timeout ~5s) are tuned for a
        // warm connection pool — a serverless Postgres connection's
        // cold-start cost alone (measured elsewhere in this codebase,
        // see rsvp.service.ts's own transaction options, at 6-6.5s) can
        // exceed both. Raised here for the same reason, confirmed by
        // this exact transaction hitting P2028 ("unable to start a
        // transaction in the given time") in testing before this fix.
        maxWait: 10000,
        timeout: 15000,
      });
      return 'processed';
    } catch (err) {
      if (!isDuplicateWebhookEvent(err)) throw err;

      // A retry of a delivery we've already handled — still worth a
      // ledger row (the fact that Paystack retried is itself part of
      // the record) but no further action, and no second idempotency
      // row (that insert is exactly what just failed).
      await paymentLedgerRepository.create({
        type: 'WEBHOOK_EVENT_DUPLICATE',
        amountCents,
        currency,
        paystackReference: reference,
        relatedType: 'webhook',
        relatedId: payload.event,
        payload: jsonPayload,
      });
      return 'duplicate';
    }
  },
};
