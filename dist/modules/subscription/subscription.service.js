import crypto from 'crypto';
import {} from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { describePaystackFailure } from '../../shared/payments/paystack.client.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { subscriptionRepository } from './subscription.repository.js';
import { resolveEffectiveTier } from './effective-tier.util.js';
import { getPlanCode, resolveTierAndPeriodFromPlanCode, SUBSCRIPTION_PRICES_CENTS, isPaidTier, } from './subscription-plans.config.js';
import {} from './subscription.types.js';
const generateSubscribeReference = () => `sub_${crypto.randomBytes(16).toString('hex')}`;
// Every synchronous Paystack call in this file that can fail (as
// opposed to an outcome reported later by webhook, handled separately
// below) throws through this. A real Paystack rejection — a bad email
// on file, an unrecognised plan code, a declined card at initialize
// time — is a 422: the request shape was valid, a precondition wasn't
// met. Anything else (most notably subscription-plans.config.ts's
// getPlanCode throwing because a PAYSTACK_PLAN_* env var isn't set —
// see that file's own comment) never reached Paystack with a request
// at all; that is a server misconfiguration, not a rejected charge, so
// it is a 500 — no tenant input, retry, or different card fixes it.
const toSubscriptionHttpError = (failure, fallbackMessage) => new HttpError(failure.isPaystackRejection ? 422 : 500, failure.isPaystackRejection ? failure.summary : fallbackMessage);
const TIER_RANK = { SPARK: 0, CELEBRATE: 1, ELEVATE: 2 };
const PERIOD_RANK = { MONTHLY: 0, ANNUAL: 1 };
// ─────────────────────────────────────────
//  SUBSCRIPTION SERVICE
//
//  PAYSTACK MANAGES THE SCHEDULE, NOT US. This file never charges a
//  card on its own initiative — every renewal is Paystack's own
//  scheduled action, reported back to us by webhook
//  (payment-webhook.service.ts's dispatch calls the *WithinTransaction
//  functions below). The only Paystack calls this file makes
//  proactively are: starting a NEW checkout (subscribe), reusing an
//  existing card to switch plans immediately (changeTier's upgrade
//  path), and disabling a subscription (changeTier's downgrade path,
//  cancel). None of those are "charge the card because time has
//  passed" — that action belongs to Paystack alone.
// ─────────────────────────────────────────
export const subscriptionService = {
    // Read-only mirror of SUBSCRIPTION_PRICES_CENTS — the frontend was
    // duplicating these four prices in its own config (no endpoint
    // existed to read them from), which drifts silently: a tenant sees
    // one number on the pricing page and is charged another the moment
    // this file's own constant changes. Pure and synchronous, no tenantId
    // param — pricing is not tenant-specific, so subscription.router.ts's
    // requireOwnTenantId doesn't apply here; it's still mounted behind
    // the router's own authenticate+requireTenantAdmin guard rather than
    // opened up as a new unauthenticated surface just to serve four numbers.
    getPricing: () => ({
        currency: 'ZAR',
        prices: SUBSCRIPTION_PRICES_CENTS,
    }),
    getStatus: async (tenantId) => {
        const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        const effectiveTier = resolveEffectiveTier(tenant);
        const graceDeadline = tenant.subscriptionGraceStartedAt
            ? new Date(tenant.subscriptionGraceStartedAt.getTime() + 5 * 24 * 60 * 60 * 1000)
            : null;
        return {
            tier: effectiveTier,
            storedTier: tenant.subscriptionTier,
            period: tenant.subscriptionPeriod,
            currentPeriodEnd: tenant.subscriptionCurrentPeriodEnd,
            cancelAtPeriodEnd: tenant.subscriptionCancelAtPeriodEnd,
            pendingTierAfterPeriodEnd: tenant.subscriptionPendingTierAfterPeriodEnd,
            inGrace: effectiveTier !== 'SPARK' && tenant.subscriptionGraceStartedAt !== null,
            graceDeadline,
            card: tenant.paystackCardLast4
                ? {
                    brand: tenant.paystackCardBrand,
                    last4: tenant.paystackCardLast4,
                    expMonth: tenant.paystackCardExpMonth,
                    expYear: tenant.paystackCardExpYear,
                }
                : null,
        };
    },
    // ── SUBSCRIBE — a tenant with no currently-active paid subscription
    // picks a tier+period and is sent to Paystack to authorise a card.
    // The tier does NOT change here — only on the subscription.create
    // webhook that follows a successful checkout (see this file's
    // handleSubscriptionCreateWithinTransaction). This mirrors ticketing's
    // own rule exactly: the callback/synchronous path never grants
    // anything, only a webhook does.
    //
    // Deliberately uses the TENANT's own billing email (Tenant.email,
    // unique), never the calling admin's personal login email — every
    // subscription webhook is matched back to a tenant via
    // data.customer.email (see handleSubscriptionCreateWithinTransaction/
    // handleSubscriptionDisableWithinTransaction), so charging under any
    // email other than Tenant.email would make those webhooks
    // unmatchable. The router does not accept an email param for this
    // reason — there is exactly one correct value, and this function
    // reads it itself.
    subscribe: async (tenantId, dto, callbackUrl) => {
        const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        const hasActiveSubscription = tenant.paystackSubscriptionCode && !tenant.subscriptionCancelAtPeriodEnd;
        if (hasActiveSubscription) {
            throw new HttpError(409, 'This tenant already has an active subscription. Use the change-tier endpoint to switch plans instead.');
        }
        const reference = generateSubscribeReference();
        await subscriptionRepository.savePendingAttempt(tenantId, { reference, tier: dto.tier, period: dto.period });
        try {
            const result = await paystackClient.initializeTransaction({
                email: tenant.email,
                amountCents: SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period],
                currency: 'ZAR',
                reference,
                callbackUrl,
                // Card only — instant EFT cannot do unattended recurring
                // charges (this is EventGenie's own money via a recurring
                // Paystack Plan, opposite direction and opposite constraint
                // from a ticket guest's one-off payment).
                channels: ['card'],
                plan: getPlanCode(dto.tier, dto.period),
            });
            await paymentLedgerService.record({
                type: 'SUBSCRIPTION_CHARGE_INITIATED',
                amountCents: SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period],
                currency: 'ZAR',
                tenantId,
                paystackReference: reference,
                relatedType: 'Tenant',
                relatedId: tenantId,
                payload: { tier: dto.tier, period: dto.period },
            });
            return { authorizationUrl: result.authorizationUrl };
        }
        catch (err) {
            const failure = describePaystackFailure(err);
            // Named, correlatable, and actually present in the logs — this
            // exact failure used to reach neither the console nor a usable
            // ledger payload (see the payload write below, and
            // paystack.client.ts's PaystackApiError.raw for what closed that
            // gap). `err` itself, not just failure.summary, so a
            // PaystackApiError's `raw` (Paystack's own response body) prints
            // too, not only its message.
            console.error(`[subscription] checkout initialization failed — tenant ${tenantId}, ref ${reference}, plan ${dto.tier}/${dto.period}:`, err);
            await subscriptionRepository.clearPendingAttempt(tenantId);
            await paymentLedgerService.record({
                type: 'SUBSCRIPTION_CHARGE_FAILED',
                amountCents: SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period],
                currency: 'ZAR',
                tenantId,
                paystackReference: reference,
                relatedType: 'Tenant',
                relatedId: tenantId,
                // The provider's actual response (or, for a config error, the
                // real JS error) lives in `raw` — `summary` sits alongside it
                // for a quick glance, never replacing it. See this file's own
                // header note on why a sanitised string used to be written here
                // instead, and what that cost.
                payload: { stage: 'initialize', summary: failure.summary, raw: failure.raw },
            });
            throw toSubscriptionHttpError(failure, 'Something went wrong while starting this subscription. Please try again, or contact support if this keeps happening.');
        }
    },
    // ── CHANGE TIER — upgrade/downgrade between Celebrate and Elevate,
    // and switching monthly<->annual. Requires an existing subscription
    // (use subscribe() for a tenant's first one).
    //
    // PRORATION DECISION (see batch report for the full argument):
    // Paystack does not support proration on subscriptions at all — its
    // own guidance for any plan change is "cancel the old subscription
    // and create a new one." Building proration ourselves was explicitly
    // out of scope (no prorated credits). So:
    //   - An UPGRADE in value (a higher tier, or the same tier moving
    //     MONTHLY -> ANNUAL) takes effect NOW: the old subscription is
    //     disabled and a new one is created immediately, charging the
    //     new plan's FULL price today via the tenant's existing saved
    //     card — no proration, no top-up math, just what the customer
    //     expects when they pay to unlock something today. The tier only
    //     actually flips once the resulting subscription.create webhook
    //     confirms it (same "webhook is the source of truth" rule as
    //     everywhere else in this codebase).
    //   - A DOWNGRADE in value (a lower tier, or ANNUAL -> MONTHLY on the
    //     same tier) takes effect at PERIOD END: they already paid for
    //     the current period, so the current subscription is disabled
    //     (it will not renew) but access continues, via
    //     effective-tier.util.ts's derivation, until
    //     subscriptionCurrentPeriodEnd. See that file's own comment, and
    //     Tenant.subscriptionPendingTierAfterPeriodEnd's schema comment,
    //     for why landing the tenant on the NEW lower paid tier at that
    //     boundary is not automatic — it needs the tenant's own
    //     resubscription, since this codebase has no scheduler and
    //     Paystack has no documented future-dated subscription start.
    changeTier: async (tenantId, dto) => {
        const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        if (!tenant.paystackSubscriptionCode || !tenant.paystackSubscriptionEmailToken || !tenant.paystackCustomerCode) {
            throw new HttpError(422, 'This tenant has no active subscription to change. Use the subscribe endpoint first.');
        }
        if (tenant.subscriptionCancelAtPeriodEnd) {
            throw new HttpError(409, 'This subscription is already scheduled to end at the current period. Subscribe again to pick a new plan.');
        }
        const currentRank = TIER_RANK[tenant.subscriptionTier] * 10 + (tenant.subscriptionPeriod ? PERIOD_RANK[tenant.subscriptionPeriod] : 0);
        const targetRank = TIER_RANK[dto.tier] * 10 + PERIOD_RANK[dto.period];
        const isUpgrade = targetRank > currentRank;
        if (isUpgrade) {
            try {
                await paystackClient.disableSubscription(tenant.paystackSubscriptionCode, tenant.paystackSubscriptionEmailToken);
            }
            catch (err) {
                // If Paystack can't find/disable the old one, proceeding to
                // create a new one would risk the tenant paying for two active
                // subscriptions at once — refuse rather than risk a double
                // charge.
                const failure = describePaystackFailure(err);
                console.error(`[subscription] disable-before-upgrade failed — tenant ${tenantId}, target ${dto.tier}/${dto.period}:`, err);
                throw toSubscriptionHttpError(failure, 'Could not update the existing subscription.');
            }
            try {
                const created = await paystackClient.createSubscription({
                    customerCode: tenant.paystackCustomerCode,
                    planCode: getPlanCode(dto.tier, dto.period),
                    ...(tenant.paystackAuthorizationCode !== null && { authorizationCode: tenant.paystackAuthorizationCode }),
                });
                await paymentLedgerService.record({
                    type: 'SUBSCRIPTION_CHARGE_INITIATED',
                    amountCents: SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period],
                    currency: 'ZAR',
                    tenantId,
                    paystackReference: created.subscriptionCode,
                    relatedType: 'Tenant',
                    relatedId: tenantId,
                    payload: { tier: dto.tier, period: dto.period, upgrade: true },
                });
                // The tier flip itself waits for subscription.create /
                // charge.success, same rule as subscribe() — this call
                // succeeding synchronously means Paystack ACCEPTED the
                // request, not that the tenant is confirmed on the new plan
                // yet.
                return { outcome: 'accepted' };
            }
            catch (err) {
                const failure = describePaystackFailure(err);
                console.error(`[subscription] upgrade charge failed — tenant ${tenantId}, target ${dto.tier}/${dto.period}:`, err);
                await paymentLedgerService.record({
                    type: 'SUBSCRIPTION_CHARGE_FAILED',
                    amountCents: SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period],
                    currency: 'ZAR',
                    tenantId,
                    relatedType: 'Tenant',
                    relatedId: tenantId,
                    payload: { stage: 'upgrade', summary: failure.summary, raw: failure.raw },
                });
                throw toSubscriptionHttpError(failure, 'Could not start the new plan. Please contact support — your previous plan may need to be restored.');
            }
        }
        // Downgrade — deferred to period end, per the decision above.
        try {
            await paystackClient.disableSubscription(tenant.paystackSubscriptionCode, tenant.paystackSubscriptionEmailToken);
        }
        catch (err) {
            const failure = describePaystackFailure(err);
            console.error(`[subscription] downgrade-disable failed — tenant ${tenantId}, target ${dto.tier}/${dto.period}:`, err);
            throw toSubscriptionHttpError(failure, 'Could not schedule this downgrade.');
        }
        await subscriptionRepository.scheduleEndOfPeriodChange(tenantId, dto.tier);
        await paymentLedgerService.record({
            type: 'SUBSCRIPTION_TIER_CHANGED',
            amountCents: 0,
            currency: 'ZAR',
            tenantId,
            relatedType: 'Tenant',
            relatedId: tenantId,
            payload: {
                from: { tier: tenant.subscriptionTier, period: tenant.subscriptionPeriod },
                pendingTo: { tier: dto.tier, period: dto.period },
                effectiveAt: tenant.subscriptionCurrentPeriodEnd,
            },
        });
        return { outcome: 'scheduled', effectiveAt: tenant.subscriptionCurrentPeriodEnd };
    },
    // ── UPDATE CARD LINK — the fix action for a tenant in grace (a
    // renewal charge failed) and for anyone who just wants to replace
    // their card pre-emptively. Neither subscribe() (409s while a
    // subscription is already active — see above) nor changeTier() (same
    // tier+period would fall into the DOWNGRADE branch and schedule an
    // end-of-period lapse, not fix anything) can do this — see
    // paystack.client.ts's generateSubscriptionManageLink for why this
    // needs its own Paystack call. Returns Paystack's own hosted link;
    // the browser is sent there directly, same redirect-based shape as
    // subscribe()'s authorizationUrl.
    getUpdateCardLink: async (tenantId) => {
        const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        if (!tenant.paystackSubscriptionCode) {
            throw new HttpError(422, 'This tenant has no subscription to update a card for.');
        }
        try {
            const link = await paystackClient.generateSubscriptionManageLink(tenant.paystackSubscriptionCode);
            return { link };
        }
        catch (err) {
            const failure = describePaystackFailure(err);
            console.error(`[subscription] update-card-link failed — tenant ${tenantId}:`, err);
            throw toSubscriptionHttpError(failure, 'Could not generate a card update link. Please try again.');
        }
    },
    // ── CANCEL — same mechanism as a downgrade, target tier SPARK
    // (nothing to resubscribe to automatically since Spark is free).
    cancel: async (tenantId) => {
        const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        if (!tenant.paystackSubscriptionCode || !tenant.paystackSubscriptionEmailToken) {
            throw new HttpError(422, 'This tenant has no active subscription to cancel.');
        }
        if (tenant.subscriptionCancelAtPeriodEnd) {
            return { effectiveAt: tenant.subscriptionCurrentPeriodEnd };
        }
        try {
            await paystackClient.disableSubscription(tenant.paystackSubscriptionCode, tenant.paystackSubscriptionEmailToken);
        }
        catch (err) {
            const failure = describePaystackFailure(err);
            console.error(`[subscription] cancel failed — tenant ${tenantId}:`, err);
            throw toSubscriptionHttpError(failure, 'Could not cancel this subscription.');
        }
        await subscriptionRepository.scheduleEndOfPeriodChange(tenantId, null);
        await paymentLedgerService.record({
            type: 'SUBSCRIPTION_CANCELLED',
            amountCents: 0,
            currency: 'ZAR',
            tenantId,
            relatedType: 'Tenant',
            relatedId: tenantId,
            payload: {
                from: { tier: tenant.subscriptionTier, period: tenant.subscriptionPeriod },
                effectiveAt: tenant.subscriptionCurrentPeriodEnd,
            },
        });
        return { effectiveAt: tenant.subscriptionCurrentPeriodEnd };
    },
    // ── WEBHOOK: charge.success ──
    //
    // Matched two ways (see payment-webhook.service.ts's dispatch): by
    // OUR OWN chosen reference (a fresh subscribe attempt — this webhook
    // just confirms payment; the actual tier flip waits for
    // subscription.create, which alone carries the authoritative
    // subscription_code/email_token/next_payment_date) or by
    // paystackCustomerCode (a renewal, or an upgrade's resulting charge —
    // both handled identically, since the correct reaction is the same
    // either way: confirm payment, clear grace, and refresh the period
    // end). Returns a postCommit callback for the renewal case, since
    // learning the fresh next_payment_date needs an external Paystack
    // call that must NOT run inside the webhook's own DB transaction
    // (same reasoning ticket-purchase.service.ts already established for
    // never calling Paystack from inside an interactive transaction).
    handleChargeSuccessWithinTransaction: async (tx, data) => {
        const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
        const customer = data['customer'];
        const amountCents = typeof data['amount'] === 'number' ? data['amount'] : 0;
        // Path A — the tenant's own pending first-subscribe attempt.
        if (reference) {
            const pending = await subscriptionRepository.findByPendingReference(reference, tx);
            if (pending) {
                if (customer?.customer_code) {
                    await subscriptionRepository.recordChargeSucceededPreliminary(pending.id, { customerCode: customer.customer_code }, tx);
                }
                await paymentLedgerService.record({
                    type: 'SUBSCRIPTION_CHARGE_SUCCEEDED',
                    amountCents,
                    currency: 'ZAR',
                    tenantId: pending.id,
                    paystackReference: reference,
                    relatedType: 'Tenant',
                    relatedId: pending.id,
                    payload: data,
                }, tx);
                return { claimed: true };
            }
        }
        // Path B — an ongoing subscription's renewal (or an upgrade's
        // resulting charge — same handling either way).
        if (customer?.customer_code) {
            const tenant = await subscriptionRepository.findByCustomerCode(customer.customer_code, tx);
            if (tenant) {
                await subscriptionRepository.recordChargeSucceededPreliminary(tenant.id, { customerCode: customer.customer_code }, tx);
                await paymentLedgerService.record({
                    type: 'SUBSCRIPTION_CHARGE_SUCCEEDED',
                    amountCents,
                    currency: 'ZAR',
                    tenantId: tenant.id,
                    paystackReference: reference,
                    relatedType: 'Tenant',
                    relatedId: tenant.id,
                    payload: data,
                }, tx);
                // Only worth refreshing next_payment_date if we already have a
                // subscription to ask Paystack about — a brand-new subscribe's
                // charge.success (Path A) has no subscriptionCode yet at this
                // point, and doesn't need one: subscription.create supplies it.
                if (tenant.paystackSubscriptionCode) {
                    const subscriptionCode = tenant.paystackSubscriptionCode;
                    return {
                        claimed: true,
                        postCommit: async () => {
                            try {
                                const fresh = await paystackClient.getSubscription(subscriptionCode);
                                await subscriptionRepository.updateCurrentPeriodEnd(tenant.id, new Date(fresh.nextPaymentDate));
                            }
                            catch (err) {
                                // Best-effort — the charge is already recorded as
                                // succeeded and grace is already cleared regardless;
                                // worst case the displayed renewal date is briefly
                                // stale until the next successful sync.
                                console.error('[subscription webhook] could not refresh next_payment_date:', err);
                            }
                        },
                    };
                }
                return { claimed: true };
            }
        }
        return { claimed: false };
    },
    // ── WEBHOOK: charge.failed ── starts (or leaves alone, if already
    // started — see recordChargeFailureIfFirst) the 5-day grace clock.
    // Matched by customer_code only — a FAILED first-subscribe attempt
    // has no customer_code stored yet in most cases (the customer object
    // may still be present on a failed charge — Paystack creates the
    // customer record even for a declined charge — so this still tries
    // reference-matching first for that case) and nothing to grace (a
    // tenant who never subscribed has nothing to fall from).
    handleChargeFailedWithinTransaction: async (tx, data) => {
        const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
        const customer = data['customer'];
        const amountCents = typeof data['amount'] === 'number' ? data['amount'] : 0;
        let tenantId = null;
        if (reference) {
            const pending = await subscriptionRepository.findByPendingReference(reference, tx);
            if (pending) {
                tenantId = pending.id;
                await subscriptionRepository.clearPendingAttempt(pending.id, tx);
            }
        }
        if (!tenantId && customer?.customer_code) {
            const tenant = await subscriptionRepository.findByCustomerCode(customer.customer_code, tx);
            if (tenant) {
                tenantId = tenant.id;
                await subscriptionRepository.recordChargeFailureIfFirst(tenant.id, tx);
            }
        }
        if (!tenantId)
            return { claimed: false };
        await paymentLedgerService.record({
            type: 'SUBSCRIPTION_CHARGE_FAILED',
            amountCents,
            currency: 'ZAR',
            tenantId,
            paystackReference: reference,
            relatedType: 'Tenant',
            relatedId: tenantId,
            payload: data,
        }, tx);
        return { claimed: true };
    },
    // ── WEBHOOK: subscription.create ── the ONE authoritative activation
    // point for a brand-new subscription (first-ever subscribe, or an
    // upgrade that created a new one) — everything needed
    // (subscription_code, email_token, next_payment_date, plan,
    // authorization) arrives in this single payload, no follow-up call
    // needed. Matched by data.customer.email against Tenant.email
    // (unique) — deliberately NOT by reference or customer_code, since
    // this event carries neither in a form we chose, and matching by the
    // tenant's own billing email is reliable regardless of whether this
    // arrives before or after its sibling charge.success (webhooks are
    // not guaranteed ordered).
    handleSubscriptionCreateWithinTransaction: async (tx, data) => {
        const customer = data['customer'];
        if (!customer?.email)
            return { claimed: false };
        const tenant = await subscriptionRepository.findByEmail(customer.email, tx);
        if (!tenant)
            return { claimed: false };
        const planField = data['plan'];
        const planCode = typeof planField === 'string' ? planField : planField?.plan_code;
        const resolved = planCode ? resolveTierAndPeriodFromPlanCode(planCode) : null;
        if (!resolved) {
            console.error('[subscription webhook] subscription.create with an unrecognised plan code:', planCode);
            return { claimed: false };
        }
        const subscriptionCode = data['subscription_code'];
        const emailToken = data['email_token'];
        const nextPaymentDate = data['next_payment_date'];
        if (typeof subscriptionCode !== 'string' || typeof emailToken !== 'string' || typeof nextPaymentDate !== 'string') {
            console.error('[subscription webhook] subscription.create missing required fields');
            return { claimed: false };
        }
        const authorization = data['authorization'];
        const fromTier = tenant.subscriptionTier;
        const fromPeriod = tenant.subscriptionPeriod;
        await subscriptionRepository.activateSubscription(tenant.id, {
            tier: resolved.tier,
            period: resolved.period,
            customerCode: customer.customer_code ?? tenant.paystackCustomerCode ?? '',
            subscriptionCode,
            emailToken,
            currentPeriodEnd: new Date(nextPaymentDate),
            ...(authorization?.authorization_code !== undefined && { authorizationCode: authorization.authorization_code }),
            ...(authorization?.card_type !== undefined && { cardBrand: authorization.card_type }),
            ...(authorization?.last4 !== undefined && { cardLast4: authorization.last4 }),
            ...(authorization?.exp_month !== undefined && { cardExpMonth: authorization.exp_month }),
            ...(authorization?.exp_year !== undefined && { cardExpYear: authorization.exp_year }),
        }, tx);
        await paymentLedgerService.record({
            type: 'SUBSCRIPTION_TIER_CHANGED',
            amountCents: 0,
            currency: 'ZAR',
            tenantId: tenant.id,
            paystackReference: subscriptionCode,
            relatedType: 'Tenant',
            relatedId: tenant.id,
            payload: {
                from: { tier: fromTier, period: fromPeriod },
                to: { tier: resolved.tier, period: resolved.period },
            },
        }, tx);
        return { claimed: true };
    },
    // ── WEBHOOK: subscription.disable / subscription.not_renew ──
    // Confirms non-renewal — for a subscription WE told Paystack to
    // disable (changeTier's downgrade path, cancel), this is purely
    // confirmatory (subscriptionCancelAtPeriodEnd is already true).
    // Handled the same way if Paystack disables it for some other reason
    // (e.g. Paystack determined the card is permanently unusable) — the
    // conservative reaction either way is "stop expecting renewals",
    // which is exactly what cancelAtPeriodEnd already models; it is NOT
    // set on the tenant proactively — access still lapses to SPARK on
    // schedule via the existing grace/period-end derivation regardless of
    // whether this webhook ever arrives, so a missed delivery here is not
    // a correctness risk, only a slightly-stale
    // subscriptionCancelAtPeriodEnd flag until the next status read.
    handleSubscriptionDisableWithinTransaction: async (tx, data) => {
        const customer = data['customer'];
        if (!customer?.email)
            return { claimed: false };
        const tenant = await subscriptionRepository.findByEmail(customer.email, tx);
        if (!tenant)
            return { claimed: false };
        if (!tenant.subscriptionCancelAtPeriodEnd) {
            await subscriptionRepository.scheduleEndOfPeriodChange(tenant.id, tenant.subscriptionPendingTierAfterPeriodEnd, tx);
        }
        return { claimed: true };
    },
};
export { isPaidTier };
//# sourceMappingURL=subscription.service.js.map