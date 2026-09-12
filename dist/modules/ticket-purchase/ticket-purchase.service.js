import crypto from 'crypto';
import {} from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { decimalToCents } from '../../shared/payments/money.util.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PaystackApiError } from '../../shared/payments/paystack.client.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { assertTenantReadyToSellTickets } from '../payment-account/payment-account-readiness.util.js';
import { ticketRepository } from '../ticket/ticket.repository.js';
import { ticketPurchaseRepository } from './ticket-purchase.repository.js';
import { computeTicketChargeCents } from './ticket-purchase-pricing.util.js';
// 30 minutes — long enough for a guest to actually complete a card 3-D
// Secure step or an EFT bank-login redirect, short enough that an
// abandoned checkout doesn't lock up the last unit of a popular ticket
// for long. See schema.prisma's TicketPurchase.holdExpiresAt comment
// and this file's own report notes for the full "hold with expiry"
// design and why it was chosen over letting two guests both pay.
const HOLD_DURATION_MINUTES = 30;
// Prisma's defaults (maxWait ~2s, timeout ~5s) are tuned for a warm
// connection pool — a serverless Postgres connection's cold-start cost
// alone (measured elsewhere in this codebase at 6-6.5s, see
// rsvp.service.ts's own transaction options) can exceed both, and did
// in testing (P2028, "unable to start a transaction in the given
// time") before every transaction in this file used this.
const NEON_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 };
const generatePaymentReference = () => `tkt_${crypto.randomBytes(16).toString('hex')}`;
const nextHoldExpiry = () => new Date(Date.now() + HOLD_DURATION_MINUTES * 60_000);
// ─────────────────────────────────────────
//  TICKET PURCHASE SERVICE
//
//  Owns the money-moving side of ticketing: reserving stock, computing
//  the gross-up, starting a Paystack checkout, and confirming/failing a
//  purchase from whichever source learns the outcome first (webhook or
//  a verified callback reconciliation — see confirmPayment's comment).
//  Deliberately token-agnostic: callers (rsvp.service.ts) resolve an
//  invite token to a purchase/ticket/tenant/event before calling in
//  here, so this file never needs to know what a guest token is.
// ─────────────────────────────────────────
export const ticketPurchaseService = {
    getAll: (inviteId) => ticketPurchaseRepository.findAll(inviteId),
    getById: async (id) => {
        const purchase = await ticketPurchaseRepository.findById(id);
        if (!purchase)
            throw new HttpError(404, 'Ticket purchase not found');
        return purchase;
    },
    // Organiser-facing — "what was sold", including PENDING/FAILED/
    // EXPIRED rows, so an organiser can see this even for a cancelled
    // event (Ticketing & Payments batch — nothing about a completed sale
    // can be undone, so visibility is the only thing left to guarantee).
    // Tenant scoping happens at the router via eventService.getById,
    // transitively, same pattern as every other event-child resource.
    getAllForEvent: (eventId) => ticketPurchaseRepository.findAllForEvent(eventId),
    // ── RESERVE — pure DB work, runs INSIDE rsvp.service.ts's existing
    // submit() transaction. No Paystack call here: an external network
    // call has no place inside an interactive DB transaction (this
    // codebase has already hit real Prisma-transaction-timeout pain from
    // Neon's cold-start latency alone — see rsvp.service.ts's own
    // comment on its transaction timeout — adding Paystack's round trip
    // on top would make that far worse).
    //
    // Overselling is prevented HERE, structurally: ticketRepository.
    // reserveHold is a single conditional UPDATE, not read-then-write.
    // Throws HttpError(409) if there isn't room; nothing is partially
    // reserved.
    reserveWithinTransaction: async (tx, input) => {
        const { subaccountCode } = await assertTenantReadyToSellTickets(input.tenantId, tx);
        // Lazy expiry sweep — see ticket-purchase.repository.ts's
        // sweepExpiredHolds for why this replaces a scheduler this codebase
        // doesn't have. Run right before attempting a new hold so a lapsed
        // one is reclaimed exactly when the stock is next needed.
        const expired = await ticketPurchaseRepository.sweepExpiredHolds(input.ticket.id, tx);
        if (expired.length > 0) {
            const releasedQty = expired.reduce((sum, e) => sum + e.quantity, 0);
            await ticketRepository.releaseHold(input.ticket.id, releasedQty, tx);
        }
        const secured = await ticketRepository.reserveHold(input.ticket.id, input.quantity, tx);
        if (!secured) {
            throw new HttpError(409, "There aren't enough tickets left for the quantity you selected. Try a smaller quantity or contact the organiser.");
        }
        const unitPriceCents = decimalToCents(input.ticket.price);
        const breakdown = computeTicketChargeCents(unitPriceCents, input.quantity);
        const paymentRef = generatePaymentReference();
        const holdExpiresAt = nextHoldExpiry();
        const purchase = await ticketPurchaseRepository.create({
            ticketId: input.ticket.id,
            inviteId: input.inviteId,
            quantity: input.quantity,
            ticketPriceCents: breakdown.ticketPriceCents,
            commissionCents: breakdown.commissionCents,
            totalPaidCents: breakdown.totalChargeCents,
            currency: input.ticket.currency,
            paymentRef,
            holdExpiresAt,
        }, tx);
        // Logged before the Paystack call even happens — this states "a
        // purchase attempt with these exact amounts and this exact
        // reference was recorded", which is true regardless of whether the
        // subsequent Paystack call succeeds. If it doesn't, failPayment logs
        // a separate TICKET_PAYMENT_FAILED entry against the same
        // reference — both outcomes are first-class ledger facts, per the
        // payments foundation's own rule that an absent failure record is
        // indistinguishable from an attempt that never happened.
        await paymentLedgerService.record({
            type: 'TICKET_PAYMENT_INITIATED',
            amountCents: breakdown.totalChargeCents,
            currency: input.ticket.currency,
            tenantId: input.tenantId,
            eventId: input.eventId,
            paystackReference: paymentRef,
            relatedType: 'TicketPurchase',
            relatedId: purchase.id,
            payload: breakdown,
        }, tx);
        return {
            purchaseId: purchase.id,
            paymentRef,
            totalChargeCents: breakdown.totalChargeCents,
            platformChargeCents: breakdown.platformChargeCents,
            subaccountCode,
        };
    },
    // ── START CHECKOUT — the one external network call in the whole
    // reserve-then-pay flow, deliberately OUTSIDE any DB transaction.
    // `bearer: 'account'` (the default, passed explicitly for clarity
    // rather than relying on precedent) is what makes the organiser's
    // exact ticket price survive untouched: `transaction_charge` is
    // pinned to (total - ticketPrice), so the subaccount's share —
    // amount minus transaction_charge — is always exactly the ticket
    // price, and Paystack's own fee is deducted from the MAIN account's
    // (transaction_charge) side, never the subaccount's.
    startPaystackCheckout: async (params) => {
        try {
            const result = await paystackClient.initializeTransaction({
                email: params.guestEmail,
                amountCents: params.totalChargeCents,
                currency: 'ZAR',
                reference: params.paymentRef,
                callbackUrl: params.callbackUrl,
                channels: ['card', 'eft'],
                subaccount: params.subaccountCode,
                transactionChargeCents: params.platformChargeCents,
                bearer: 'account',
            });
            return { authorizationUrl: result.authorizationUrl };
        }
        catch (err) {
            const reason = err instanceof PaystackApiError
                ? err.paystackMessage
                : 'Could not start payment. Please try again.';
            await ticketPurchaseService.failPayment(params.paymentRef, {
                stage: 'initialize',
                reason,
            });
            return { failed: true, reason };
        }
    },
    // ── RETRY — re-uses the SAME TicketPurchase row (never creates a
    // second one for the same invite+ticket). Only meaningful from FAILED
    // or EXPIRED; PENDING/PAID are reported back as-is rather than
    // treated as errors, since a guest double-clicking "retry" after
    // their payment already went through (or is still in flight) should
    // see a status, not a rejection.
    retryPayment: async (input) => {
        const outcome = await prisma.$transaction(async (tx) => {
            const locked = await ticketPurchaseRepository.findByIdForUpdate(input.purchaseId, tx);
            if (!locked)
                throw new HttpError(404, 'Ticket purchase not found');
            if (locked.status === 'PAID')
                return { status: 'PAID' };
            if (locked.status === 'PENDING')
                return { status: 'PENDING' };
            // FAILED or EXPIRED — genuinely retryable. Re-checked here too:
            // a tenant's subaccount or plan can have changed since the
            // original attempt.
            const { subaccountCode } = await assertTenantReadyToSellTickets(input.tenantId, tx);
            const expired = await ticketPurchaseRepository.sweepExpiredHolds(input.ticketId, tx);
            if (expired.length > 0) {
                const releasedQty = expired.reduce((sum, e) => sum + e.quantity, 0);
                await ticketRepository.releaseHold(input.ticketId, releasedQty, tx);
            }
            // A retry can genuinely fail here — stock may have sold out to
            // someone else while this purchase sat FAILED/EXPIRED. That's
            // correct behaviour, not a bug: the hold-with-expiry design exists
            // specifically so this is discovered as a clean 409 BEFORE the
            // guest pays again, never after.
            const secured = await ticketRepository.reserveHold(input.ticketId, input.quantity, tx);
            if (!secured) {
                throw new HttpError(409, "There aren't enough tickets left for the quantity you selected. Try a smaller quantity or contact the organiser.");
            }
            const breakdown = computeTicketChargeCents(decimalToCents(input.ticketPrice), input.quantity);
            const paymentRef = generatePaymentReference();
            const holdExpiresAt = nextHoldExpiry();
            await ticketPurchaseRepository.resetForRetry(input.purchaseId, {
                paymentRef,
                holdExpiresAt,
                ticketPriceCents: breakdown.ticketPriceCents,
                commissionCents: breakdown.commissionCents,
                totalPaidCents: breakdown.totalChargeCents,
            }, tx);
            await paymentLedgerService.record({
                type: 'TICKET_PAYMENT_INITIATED',
                amountCents: breakdown.totalChargeCents,
                currency: input.currency,
                tenantId: locked.tenantId,
                eventId: locked.eventId,
                paystackReference: paymentRef,
                relatedType: 'TicketPurchase',
                relatedId: input.purchaseId,
                payload: breakdown,
            }, tx);
            return {
                status: 'RETRYING',
                paymentRef,
                totalChargeCents: breakdown.totalChargeCents,
                platformChargeCents: breakdown.platformChargeCents,
                subaccountCode,
            };
        }, NEON_TRANSACTION_OPTIONS);
        return outcome;
    },
    // ── RECONCILE — called from the guest's Paystack callback landing
    // page. NEVER marks a purchase paid from the callback's own query
    // parameters (those only prove the guest's browser came back, not
    // that Paystack actually approved anything). Instead, if the purchase
    // is still PENDING in our own records, this makes an authoritative
    // server-to-server call to Paystack's OWN verify endpoint — a
    // different, independent source of truth from the callback redirect
    // itself — and only acts on a definitive 'success'. Anything else
    // (still processing, abandoned, failed) is left exactly as it is:
    // the webhook (or the hold's own expiry) is what eventually resolves
    // it, and the guest sees "confirming" in the meantime rather than a
    // premature failure while they might still be retrying on Paystack's
    // own page.
    reconcile: async (purchaseId) => {
        const purchase = await ticketPurchaseRepository.findById(purchaseId);
        if (!purchase)
            throw new HttpError(404, 'Ticket purchase not found');
        if (purchase.status !== 'PENDING' || !purchase.paymentRef) {
            return { status: purchase.status };
        }
        const verified = await paystackClient.verifyTransaction(purchase.paymentRef);
        if (verified.status === 'success') {
            await ticketPurchaseService.confirmPayment(purchase.paymentRef, verified.raw);
            return { status: 'PAID' };
        }
        return { status: 'PENDING' };
    },
    // ── CONFIRM (core) — the one true "this purchase is paid" transition,
    // taking an EXTERNALLY-SUPPLIED transaction rather than opening its
    // own. Exported directly so payment-webhook.service.ts can run this
    // in the SAME transaction as its own idempotency-guard insert
    // (see that file's dispatch step) — the guard and the confirmation
    // must commit together, or a crash between them would mark a webhook
    // "seen" without the confirmation ever having happened, silently
    // losing it forever (a redelivery would then be skipped as a
    // duplicate). confirmPayment below is the standalone wrapper for
    // every OTHER caller (reconcile, tests) that doesn't already have a
    // transaction of its own to join.
    //
    // Callable from independent sources (the webhook's charge.success
    // handler, and reconcile's verified callback check) that never
    // coordinate with each other — both go through this exact function,
    // guarded by the SAME row lock, so whichever arrives first wins and
    // the second becomes a no-op — "already_handled", not an error.
    //
    // Allows the transition from PENDING, FAILED, or EXPIRED — not just
    // PENDING. Once Paystack says a charge succeeded, the money has
    // already moved (split at source, straight to the organiser's bank
    // account) regardless of what our own hold bookkeeping shows; refusing
    // to record it as PAID wouldn't undo that transfer, it would just
    // leave our own records permanently wrong. Overselling is prevented
    // upstream, at reserveHold — never here, by refusing a genuine
    // confirmation.
    confirmPaymentWithinTransaction: async (tx, paymentRef, providerPayload) => {
        const existing = await ticketPurchaseRepository.findByPaymentRef(paymentRef, tx);
        if (!existing)
            return { outcome: 'not_found' };
        const locked = await ticketPurchaseRepository.findByIdForUpdate(existing.id, tx);
        if (!locked)
            return { outcome: 'not_found' };
        if (locked.status === 'PAID')
            return { outcome: 'already_handled' };
        await ticketPurchaseRepository.markPaid(locked.id, tx);
        await ticketRepository.incrementSoldCount(locked.ticketId, locked.quantity, tx);
        // Only release the hold if one still exists — a purchase that was
        // already FAILED/EXPIRED had its hold released at that point, and
        // releasing it again would double-decrement heldCount.
        if (locked.status === 'PENDING') {
            await ticketRepository.releaseHold(locked.ticketId, locked.quantity, tx);
        }
        await paymentLedgerService.record({
            type: 'TICKET_PAYMENT_SUCCEEDED',
            amountCents: locked.totalPaidCents,
            currency: locked.currency,
            tenantId: locked.tenantId,
            eventId: locked.eventId,
            paystackReference: paymentRef,
            relatedType: 'TicketPurchase',
            relatedId: locked.id,
            payload: providerPayload,
        }, tx);
        await paymentLedgerService.record({
            type: 'COMMISSION_TAKEN',
            amountCents: locked.commissionCents,
            currency: locked.currency,
            tenantId: locked.tenantId,
            eventId: locked.eventId,
            paystackReference: paymentRef,
            relatedType: 'TicketPurchase',
            relatedId: locked.id,
        }, tx);
        return { outcome: 'confirmed' };
    },
    // Standalone wrapper — opens its own transaction. Used by reconcile()
    // above and anywhere else that isn't already inside one.
    confirmPayment: (paymentRef, providerPayload) => prisma.$transaction((tx) => ticketPurchaseService.confirmPaymentWithinTransaction(tx, paymentRef, providerPayload), NEON_TRANSACTION_OPTIONS),
    // ── FAIL (core) — shared by "Paystack rejected the initialize call
    // itself" (startPaystackCheckout's catch block, before any charge
    // attempt began) and "webhook says charge.failed". Same
    // transaction-joining reasoning as confirmPaymentWithinTransaction
    // above. Releases the hold so the stock is immediately available
    // again, marks FAILED, logs it. Guarded by the same row lock as
    // confirm, so a FAILED transition can never race a PAID one for the
    // same purchase — only ever transitions FROM PENDING; anything else
    // is already resolved and this becomes a no-op.
    failPaymentWithinTransaction: async (tx, paymentRef, providerPayload) => {
        const existing = await ticketPurchaseRepository.findByPaymentRef(paymentRef, tx);
        if (!existing)
            return { outcome: 'not_found' };
        const locked = await ticketPurchaseRepository.findByIdForUpdate(existing.id, tx);
        if (!locked)
            return { outcome: 'not_found' };
        if (locked.status !== 'PENDING')
            return { outcome: 'already_handled' };
        await ticketPurchaseRepository.markFailed(locked.id, tx);
        await ticketRepository.releaseHold(locked.ticketId, locked.quantity, tx);
        await paymentLedgerService.record({
            type: 'TICKET_PAYMENT_FAILED',
            amountCents: locked.totalPaidCents,
            currency: locked.currency,
            tenantId: locked.tenantId,
            eventId: locked.eventId,
            paystackReference: paymentRef,
            relatedType: 'TicketPurchase',
            relatedId: locked.id,
            payload: providerPayload,
        }, tx);
        return { outcome: 'failed' };
    },
    failPayment: (paymentRef, providerPayload) => prisma.$transaction((tx) => ticketPurchaseService.failPaymentWithinTransaction(tx, paymentRef, providerPayload), NEON_TRANSACTION_OPTIONS),
};
//# sourceMappingURL=ticket-purchase.service.js.map