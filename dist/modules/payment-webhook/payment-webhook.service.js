import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import { verifyWebhookSignature } from '../../shared/payments/paystack.client.js';
import { DEFAULT_CURRENCY } from '../../shared/payments/money.util.js';
import { paymentWebhookRepository } from './payment-webhook.repository.js';
import { isDuplicateWebhookEvent } from './payment-webhook-idempotency.util.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { ticketPurchaseService } from '../ticket-purchase/ticket-purchase.service.js';
import { subscriptionService } from '../subscription/subscription.service.js';
import { eventPassService } from '../event-pass/event-pass.service.js';
import {} from './payment-webhook.types.js';
// Building block for the dedupe key AND the ledger's paystackReference —
// Paystack's own transaction id (data.id) is preferred when present
// since it's stable and numeric; data.reference is the fallback for
// event types that carry a reference but no id.
const extractReference = (data) => {
    const id = data['id'];
    if (typeof id === 'string' || typeof id === 'number')
        return String(id);
    const reference = data['reference'];
    if (typeof reference === 'string')
        return reference;
    return null;
};
const extractAmountCents = (data) => {
    const amount = data['amount'];
    return typeof amount === 'number' ? amount : 0;
};
const extractCurrency = (data) => {
    const currency = data['currency'];
    return typeof currency === 'string' ? currency : DEFAULT_CURRENCY;
};
// Distinct from extractReference above on purpose: this is specifically
// Paystack's `data.reference` string — the exact value a feature module
// chose and passed as `reference` to initializeTransaction (e.g.
// TicketPurchase.paymentRef, or a subscription's own
// subscriptionPendingReference). data.id is a Paystack-internal numeric
// id that no feature module ever stores, so preferring it here (the way
// extractReference does for generic dedup purposes) would make every
// charge.success/failed dispatch fail to find its purchase — confirmed
// the hard way in ticketing's own testing before this comment existed.
//
// Subscription Billing batch note: this ONLY applies to charge.success/
// charge.failed. subscription.create/disable/not_renew carry NEITHER a
// reference NOR an id we chose — subscription.service.ts's handlers for
// those match by data.customer.email against Tenant.email instead (see
// their own comments for why that's reliable regardless of delivery
// order), so this function is never called for those event types.
const extractMerchantReference = (data) => {
    const reference = data['reference'];
    return typeof reference === 'string' ? reference : null;
};
// Routes a signature-verified, first-seen delivery to whichever feature
// actually owns it. Runs INSIDE the same transaction as the
// idempotency-guard insert (the caller's `tx`), not a fresh one: if a
// webhook's business effect and the "we've seen this delivery" marker
// didn't commit together, a crash between them would mark the delivery
// seen without the effect ever having happened — and a redelivery would
// then be silently skipped as a duplicate, losing it forever.
//
// A handler may return a `postCommit` callback for work that genuinely
// cannot run inside this transaction — specifically subscription
// renewals, which need an external Paystack API call (fetching the
// fresh next_payment_date) that must not sit inside an open DB
// transaction, the same "no external calls inside an interactive
// transaction" rule ticket-purchase.service.ts already established.
// process() below runs it AFTER the transaction commits.
//
// Falls through to the generic WEBHOOK_EVENT_UNHANDLED log for any
// event type nothing claims, and for a charge.success/failed whose
// reference/customer doesn't match anything either module owns —
// 'not_found'-shaped results from ticketing or subscription billing
// mean exactly that, not an error.
const dispatchToFeatureHandler = async (tx, event, data, jsonPayload) => {
    if (event === 'charge.success') {
        const merchantReference = extractMerchantReference(data);
        if (merchantReference) {
            const ticket = await ticketPurchaseService.confirmPaymentWithinTransaction(tx, merchantReference, jsonPayload);
            if (ticket.outcome !== 'not_found')
                return { claimed: true };
            // Event Pass batch — tried by the same merchant reference, same
            // "not_found means try the next feature" chain. paymentRef is
            // globally @unique per model, so at most one of these ever claims
            // a given reference; no prefix-parsing needed.
            const pass = await eventPassService.confirmPassPurchaseWithinTransaction(tx, merchantReference, jsonPayload);
            if (pass.outcome !== 'not_found')
                return { claimed: true };
            const bundle = await eventPassService.confirmSmsBundlePurchaseWithinTransaction(tx, merchantReference, jsonPayload);
            if (bundle.outcome !== 'not_found')
                return { claimed: true };
        }
        return subscriptionService.handleChargeSuccessWithinTransaction(tx, data);
    }
    if (event === 'charge.failed') {
        const merchantReference = extractMerchantReference(data);
        if (merchantReference) {
            const ticket = await ticketPurchaseService.failPaymentWithinTransaction(tx, merchantReference, jsonPayload);
            if (ticket.outcome !== 'not_found')
                return { claimed: true };
            const pass = await eventPassService.failPassPurchaseWithinTransaction(tx, merchantReference, jsonPayload);
            if (pass.outcome !== 'not_found')
                return { claimed: true };
            const bundle = await eventPassService.failSmsBundlePurchaseWithinTransaction(tx, merchantReference, jsonPayload);
            if (bundle.outcome !== 'not_found')
                return { claimed: true };
        }
        return subscriptionService.handleChargeFailedWithinTransaction(tx, data);
    }
    if (event === 'subscription.create') {
        return subscriptionService.handleSubscriptionCreateWithinTransaction(tx, data);
    }
    if (event === 'subscription.disable' || event === 'subscription.not_renew') {
        return subscriptionService.handleSubscriptionDisableWithinTransaction(tx, data);
    }
    return { claimed: false };
};
// ─────────────────────────────────────────
//  PAYMENT WEBHOOK SERVICE
//
//  Establishes the mechanism — verification, idempotency, logging — AND
//  dispatches to ticketing's and subscription billing's confirm/fail
//  handlers above. Any event type (or unmatched reference/customer)
//  nothing claims is still logged as WEBHOOK_EVENT_UNHANDLED so nothing
//  arriving is ever silently dropped.
// ─────────────────────────────────────────
export const paymentWebhookService = {
    // Deliberately synchronous and side-effect-free — called by the
    // router BEFORE anything else touches the request. An invalid result
    // here must lead to an immediate rejection with zero database access,
    // which is why this function itself never queries Prisma.
    isValidSignature: (rawBody, signatureHeader) => verifyWebhookSignature(rawBody, signatureHeader),
    // Only ever called once isValidSignature has returned true. Writes the
    // idempotency-guard row and the ledger row together, in one
    // transaction, so a delivery can never be marked "seen" without a
    // matching audit entry, or vice versa.
    process: async (payload) => {
        const data = payload.data ?? {};
        const reference = extractReference(data);
        const dedupeKey = `${payload.event}:${reference ?? ''}`;
        const amountCents = extractAmountCents(data);
        const currency = extractCurrency(data);
        const jsonPayload = payload;
        let postCommit;
        try {
            await prisma.$transaction(async (tx) => {
                await paymentWebhookRepository.markProcessed(payload.event, dedupeKey, tx);
                const result = await dispatchToFeatureHandler(tx, payload.event, data, jsonPayload);
                if (result.claimed) {
                    postCommit = result.postCommit;
                }
                else {
                    await paymentLedgerRepository.create({
                        type: 'WEBHOOK_EVENT_UNHANDLED',
                        amountCents,
                        currency,
                        paystackReference: reference,
                        relatedType: 'webhook',
                        relatedId: payload.event,
                        payload: jsonPayload,
                    }, tx);
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
            // Deliberately AFTER the transaction has committed — see
            // dispatchToFeatureHandler's own comment on why a subscription
            // renewal's follow-up Paystack call cannot run inside it.
            if (postCommit)
                await postCommit();
            return 'processed';
        }
        catch (err) {
            if (!isDuplicateWebhookEvent(err))
                throw err;
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
//# sourceMappingURL=payment-webhook.service.js.map