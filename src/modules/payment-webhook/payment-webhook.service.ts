import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { verifyWebhookSignature } from '../../shared/payments/paystack.client.js';
import { DEFAULT_CURRENCY } from '../../shared/payments/money.util.js';
import { paymentWebhookRepository } from './payment-webhook.repository.js';
import { isDuplicateWebhookEvent } from './payment-webhook-idempotency.util.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { ticketPurchaseService } from '../ticket-purchase/ticket-purchase.service.js';
import { subscriptionService } from '../subscription/subscription.service.js';
import { eventPassService } from '../event-pass/event-pass.service.js';
import { paymentAdjustmentService, REFUND_EVENTS, DISPUTE_EVENTS } from '../payment-adjustment/payment-adjustment.service.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import { runPostCommit, PAYMENT_TRANSACTION_OPTIONS, type PostCommitWork } from './payment-context.util.js';
import {
  type PaystackWebhookPayload,
  type WebhookProcessOutcome,
  type WebhookContext,
  type HandlerResult,
} from './payment-webhook.types.js';

// The object a delivery is about, for the dedupe key's readable part and
// the ledger's paystackReference on an unhandled/duplicate row: Paystack's
// own id when present, else the reference.
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

// Specifically Paystack's `data.reference` string — the exact value a
// feature chose and passed to initializeTransaction (TicketPurchase.paymentRef,
// EventPassPurchase.paymentRef, a subscribe attempt's reference). data.id is
// Paystack's own and never one of ours, so charge.success/failed dispatch
// uses this, never extractReference.
const extractMerchantReference = (data: Record<string, unknown>): string | null => {
  const reference = data['reference'];
  return typeof reference === 'string' ? reference : null;
};

// ─────────────────────────────────────────
//  THE DEDUPE KEY (payments release 1)
//
//  `${event}:${data.id ?? data.reference ?? 'none'}:${sha256(raw body)}`.
//  Paystack has no delivery id. A retry of one delivery resends the same
//  bytes, so it gets the same key and is recorded as a duplicate. Two
//  DIFFERENT deliveries about one object (invoice.update unpaid then paid;
//  repeated dispute reminders; any event with neither an id nor a
//  reference) get different keys and are both handled. Every handler is
//  idempotent too, so a retry whose bytes somehow differ is still harmless.
//  Before release 1 the key was `${event}:${id ?? reference}`: an id-less
//  event collided with every other one of its type.
// ─────────────────────────────────────────
export const webhookDedupeKey = (event: string, data: Record<string, unknown>, rawBody: Buffer | string): string => {
  const hash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return `${event}:${extractReference(data) ?? 'none'}:${hash}`;
};

// Understood, deliberately not acted on, never alerted.
const INFORMATIONAL_EVENTS = new Set(['invoice.create', 'subscription.expiring_cards', 'customeridentification.success', 'customeridentification.failed']);

// Routes a signature-verified, first-seen delivery to whichever feature owns
// it. Runs INSIDE the same transaction as the dedupe insert: the "seen"
// marker and the effect commit together, or neither does.
const dispatchToFeatureHandler = async (ctx: WebhookContext): Promise<HandlerResult> => {
  const { tx, event, data, payload } = ctx;

  if (event === 'charge.success') {
    const merchantReference = extractMerchantReference(data);
    if (merchantReference) {
      // Ticketing first, unchanged by release 1.
      const ticket = await ticketPurchaseService.confirmPaymentWithinTransaction(tx, merchantReference, payload);
      if (ticket.outcome !== 'not_found') return { claimed: true };

      // paymentRef is globally @unique per model, so at most one of these
      // ever claims a given reference.
      const pass = await eventPassService.confirmPassPurchaseWithinTransaction(ctx, merchantReference);
      if (pass.outcome !== 'not_found') return { claimed: true };

      const bundle = await eventPassService.confirmSmsBundlePurchaseWithinTransaction(ctx, merchantReference);
      if (bundle.outcome !== 'not_found') return { claimed: true };
    }
    return subscriptionService.handleChargeSuccessWithinTransaction(ctx);
  }

  if (event === 'charge.failed') {
    const merchantReference = extractMerchantReference(data);
    if (merchantReference) {
      const ticket = await ticketPurchaseService.failPaymentWithinTransaction(tx, merchantReference, payload);
      if (ticket.outcome !== 'not_found') return { claimed: true };

      const pass = await eventPassService.failPassPurchaseWithinTransaction(ctx, merchantReference);
      if (pass.outcome !== 'not_found') return { claimed: true };

      const bundle = await eventPassService.failSmsBundlePurchaseWithinTransaction(ctx, merchantReference);
      if (bundle.outcome !== 'not_found') return { claimed: true };
    }
    return subscriptionService.handleChargeFailedWithinTransaction(ctx);
  }

  if (event === 'subscription.create') return subscriptionService.handleSubscriptionCreateWithinTransaction(ctx);

  if (event === 'subscription.disable' || event === 'subscription.not_renew') {
    return subscriptionService.handleSubscriptionDisableWithinTransaction(ctx);
  }

  if (event === 'invoice.payment_failed' || event === 'invoice.update') {
    return subscriptionService.handleInvoiceWithinTransaction(ctx);
  }

  if (REFUND_EVENTS.includes(event)) return paymentAdjustmentService.handleRefundWithinTransaction(ctx);
  if (DISPUTE_EVENTS.includes(event)) return paymentAdjustmentService.handleDisputeWithinTransaction(ctx);

  if (INFORMATIONAL_EVENTS.has(event)) {
    await paymentLedgerRepository.create(
      {
        type: 'WEBHOOK_EVENT_IGNORED',
        amountCents: extractAmountCents(data),
        currency: extractCurrency(data),
        paystackReference: extractReference(data),
        relatedType: 'webhook',
        relatedId: event,
        payload: { reason: 'INFORMATIONAL', provider: payload } as unknown as Prisma.InputJsonValue,
      },
      tx
    );
    return { claimed: true };
  }

  return { claimed: false };
};

// ─────────────────────────────────────────
//  PAYMENT WEBHOOK SERVICE
//
//  Verification, idempotency, dispatch, and the record of anything nothing
//  claimed (WEBHOOK_EVENT_UNHANDLED, alerted to the super admin: an event
//  type we don't handle, or a charge for a reference/customer we don't
//  know). Handlers' post-commit work (Paystack calls, alerts) runs after
//  the transaction commits and never fails the webhook.
// ─────────────────────────────────────────
export const paymentWebhookService = {
  // Deliberately synchronous and side-effect-free — called by the router
  // BEFORE anything else touches the request.
  isValidSignature: (rawBody: Buffer, signatureHeader: string | string[] | undefined): boolean =>
    verifyWebhookSignature(rawBody, signatureHeader),

  // Only ever called once isValidSignature has returned true.
  process: async (payload: PaystackWebhookPayload, rawBody: Buffer | string): Promise<WebhookProcessOutcome> => {
    const data = payload.data ?? {};
    const reference = extractReference(data);
    const dedupeKey = webhookDedupeKey(payload.event, data, rawBody);
    const amountCents = extractAmountCents(data);
    const currency = extractCurrency(data);
    const jsonPayload = payload as unknown as Prisma.InputJsonValue;

    const work: PostCommitWork[] = [];

    try {
      await prisma.$transaction(async (tx) => {
        work.length = 0;
        await paymentWebhookRepository.markProcessed(payload.event, dedupeKey, tx);

        const ctx: WebhookContext = { tx, event: payload.event, data, payload: jsonPayload, after: (piece) => work.push(piece) };
        const result = await dispatchToFeatureHandler(ctx);
        if (!result.claimed) {
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
          work.push(async () => {
            await paymentAlertService.send({
              kind: 'UNHANDLED_WEBHOOK',
              subject: `Paystack sent a webhook nothing handled: ${payload.event}`,
              lines: [
                'It was recorded in the ledger (WEBHOOK_EVENT_UNHANDLED) and nothing was changed.',
                'If it is about money (a payment for a reference we don’t know), check it in Paystack’s dashboard.',
              ],
              facts: [`Event: ${payload.event}`, `Id or reference: ${reference ?? 'none'}`, `Amount: ${amountCents} cents ${currency}`],
            });
          });
        }
      }, PAYMENT_TRANSACTION_OPTIONS);
    } catch (err) {
      if (!isDuplicateWebhookEvent(err)) throw err;

      // A retry of a delivery already handled — recorded, nothing else.
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

    await runPostCommit(work);
    return 'processed';
  },
};
