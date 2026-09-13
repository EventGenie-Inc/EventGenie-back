import crypto from 'crypto';
import { type Prisma, type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PaystackApiError } from '../../shared/payments/paystack.client.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { subscriptionRepository } from './subscription.repository.js';
import { resolveEffectiveTier } from './effective-tier.util.js';
import {
  getPlanCode,
  resolveTierAndPeriodFromPlanCode,
  SUBSCRIPTION_PRICES_CENTS,
  isPaidTier,
  type PaidSubscriptionTier,
} from './subscription-plans.config.js';
import { type SubscribeDto, type ChangeTierDto, type SubscriptionStatusDto, type CheckoutResult, type ChangeTierResult } from './subscription.types.js';

const generateSubscribeReference = (): string => `sub_${crypto.randomBytes(16).toString('hex')}`;

const TIER_RANK: Record<SubscriptionTier, number> = { SPARK: 0, CELEBRATE: 1, ELEVATE: 2 };
const PERIOD_RANK: Record<SubscriptionPeriod, number> = { MONTHLY: 0, ANNUAL: 1 };

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
  getStatus: async (tenantId: string): Promise<SubscriptionStatusDto> => {
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

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
  subscribe: async (tenantId: string, dto: SubscribeDto, callbackUrl: string): Promise<CheckoutResult> => {
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

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
        payload: { tier: dto.tier, period: dto.period } as unknown as Prisma.InputJsonValue,
      });

      return { authorizationUrl: result.authorizationUrl };
    } catch (err) {
      const reason = err instanceof PaystackApiError ? err.paystackMessage : 'Could not start subscription checkout. Please try again.';
      await subscriptionRepository.clearPendingAttempt(tenantId);
      await paymentLedgerService.record({
        type: 'SUBSCRIPTION_CHARGE_FAILED',
        amountCents: SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period],
        currency: 'ZAR',
        tenantId,
        paystackReference: reference,
        relatedType: 'Tenant',
        relatedId: tenantId,
        payload: { stage: 'initialize', reason } as unknown as Prisma.InputJsonValue,
      });
      return { failed: true, reason };
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
  changeTier: async (tenantId: string, dto: ChangeTierDto): Promise<ChangeTierResult> => {
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

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
      } catch (err) {
        // If Paystack can't find/disable the old one, proceeding to
        // create a new one would risk the tenant paying for two active
        // subscriptions at once — refuse rather than risk a double
        // charge.
        const reason = err instanceof PaystackApiError ? err.paystackMessage : 'Could not update the existing subscription.';
        throw new HttpError(422, reason);
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
          payload: { tier: dto.tier, period: dto.period, upgrade: true } as unknown as Prisma.InputJsonValue,
        });

        // The tier flip itself waits for subscription.create /
        // charge.success, same rule as subscribe() — this call
        // succeeding synchronously means Paystack ACCEPTED the
        // request, not that the tenant is confirmed on the new plan
        // yet.
        return { outcome: 'accepted' };
      } catch (err) {
        const reason = err instanceof PaystackApiError ? err.paystackMessage : 'Could not start the new plan. Please contact support — your previous plan may need to be restored.';
        await paymentLedgerService.record({
          type: 'SUBSCRIPTION_CHARGE_FAILED',
          amountCents: SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period],
          currency: 'ZAR',
          tenantId,
          relatedType: 'Tenant',
          relatedId: tenantId,
          payload: { stage: 'upgrade', reason } as unknown as Prisma.InputJsonValue,
        });
        return { outcome: 'failed', reason };
      }
    }

    // Downgrade — deferred to period end, per the decision above.
    try {
      await paystackClient.disableSubscription(tenant.paystackSubscriptionCode, tenant.paystackSubscriptionEmailToken);
    } catch (err) {
      const reason = err instanceof PaystackApiError ? err.paystackMessage : 'Could not schedule this downgrade.';
      throw new HttpError(422, reason);
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
      } as unknown as Prisma.InputJsonValue,
    });

    return { outcome: 'scheduled', effectiveAt: tenant.subscriptionCurrentPeriodEnd };
  },

  // ── CANCEL — same mechanism as a downgrade, target tier SPARK
  // (nothing to resubscribe to automatically since Spark is free).
  cancel: async (tenantId: string): Promise<{ effectiveAt: Date | null }> => {
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    if (!tenant.paystackSubscriptionCode || !tenant.paystackSubscriptionEmailToken) {
      throw new HttpError(422, 'This tenant has no active subscription to cancel.');
    }
    if (tenant.subscriptionCancelAtPeriodEnd) {
      return { effectiveAt: tenant.subscriptionCurrentPeriodEnd };
    }

    try {
      await paystackClient.disableSubscription(tenant.paystackSubscriptionCode, tenant.paystackSubscriptionEmailToken);
    } catch (err) {
      const reason = err instanceof PaystackApiError ? err.paystackMessage : 'Could not cancel this subscription.';
      throw new HttpError(422, reason);
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
      } as unknown as Prisma.InputJsonValue,
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
  handleChargeSuccessWithinTransaction: async (
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>
  ): Promise<{ claimed: boolean; postCommit?: () => Promise<void> }> => {
    const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
    const customer = data['customer'] as { customer_code?: string; email?: string } | undefined;
    const amountCents = typeof data['amount'] === 'number' ? data['amount'] : 0;

    // Path A — the tenant's own pending first-subscribe attempt.
    if (reference) {
      const pending = await subscriptionRepository.findByPendingReference(reference, tx);
      if (pending) {
        if (customer?.customer_code) {
          await subscriptionRepository.recordChargeSucceededPreliminary(pending.id, { customerCode: customer.customer_code }, tx);
        }
        await paymentLedgerService.record(
          {
            type: 'SUBSCRIPTION_CHARGE_SUCCEEDED',
            amountCents,
            currency: 'ZAR',
            tenantId: pending.id,
            paystackReference: reference,
            relatedType: 'Tenant',
            relatedId: pending.id,
            payload: data as unknown as Prisma.InputJsonValue,
          },
          tx
        );
        return { claimed: true };
      }
    }

    // Path B — an ongoing subscription's renewal (or an upgrade's
    // resulting charge — same handling either way).
    if (customer?.customer_code) {
      const tenant = await subscriptionRepository.findByCustomerCode(customer.customer_code, tx);
      if (tenant) {
        await subscriptionRepository.recordChargeSucceededPreliminary(tenant.id, { customerCode: customer.customer_code }, tx);
        await paymentLedgerService.record(
          {
            type: 'SUBSCRIPTION_CHARGE_SUCCEEDED',
            amountCents,
            currency: 'ZAR',
            tenantId: tenant.id,
            paystackReference: reference,
            relatedType: 'Tenant',
            relatedId: tenant.id,
            payload: data as unknown as Prisma.InputJsonValue,
          },
          tx
        );

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
              } catch (err) {
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
  handleChargeFailedWithinTransaction: async (
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>
  ): Promise<{ claimed: boolean }> => {
    const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
    const customer = data['customer'] as { customer_code?: string } | undefined;
    const amountCents = typeof data['amount'] === 'number' ? data['amount'] : 0;

    let tenantId: string | null = null;

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

    if (!tenantId) return { claimed: false };

    await paymentLedgerService.record(
      {
        type: 'SUBSCRIPTION_CHARGE_FAILED',
        amountCents,
        currency: 'ZAR',
        tenantId,
        paystackReference: reference,
        relatedType: 'Tenant',
        relatedId: tenantId,
        payload: data as unknown as Prisma.InputJsonValue,
      },
      tx
    );

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
  handleSubscriptionCreateWithinTransaction: async (
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>
  ): Promise<{ claimed: boolean }> => {
    const customer = data['customer'] as { customer_code?: string; email?: string } | undefined;
    if (!customer?.email) return { claimed: false };

    const tenant = await subscriptionRepository.findByEmail(customer.email, tx);
    if (!tenant) return { claimed: false };

    const planField = data['plan'];
    const planCode = typeof planField === 'string' ? planField : (planField as { plan_code?: string } | undefined)?.plan_code;
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

    const authorization = data['authorization'] as
      | { authorization_code?: string; card_type?: string; last4?: string; exp_month?: string; exp_year?: string }
      | undefined;

    const fromTier = tenant.subscriptionTier;
    const fromPeriod = tenant.subscriptionPeriod;

    await subscriptionRepository.activateSubscription(
      tenant.id,
      {
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
      },
      tx
    );

    await paymentLedgerService.record(
      {
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
        } as unknown as Prisma.InputJsonValue,
      },
      tx
    );

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
  handleSubscriptionDisableWithinTransaction: async (
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>
  ): Promise<{ claimed: boolean }> => {
    const customer = data['customer'] as { email?: string } | undefined;
    if (!customer?.email) return { claimed: false };

    const tenant = await subscriptionRepository.findByEmail(customer.email, tx);
    if (!tenant) return { claimed: false };

    if (!tenant.subscriptionCancelAtPeriodEnd) {
      await subscriptionRepository.scheduleEndOfPeriodChange(tenant.id, tenant.subscriptionPendingTierAfterPeriodEnd, tx);
    }

    return { claimed: true };
  },
};

export { isPaidTier, type PaidSubscriptionTier };
