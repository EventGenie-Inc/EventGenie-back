import { normalizeEmail } from '../../shared/utils/email.util.js';
import crypto from 'crypto';
import { type Prisma, type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import {
  describePaystackFailure,
  isUncertainPaystackFailure,
  PaystackApiError,
} from '../../shared/payments/paystack.client.js';
import {
  toPaymentHttpError,
  alreadyPendingError,
  type PendingPurchaseDetails,
  PAYMENT_IN_PROGRESS,
  PAYMENT_IN_PROGRESS_MESSAGE,
  PAYMENT_PROVIDER_UNAVAILABLE,
  PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE,
} from '../../shared/payments/payment-errors.util.js';
import { checkAmount, paidAtOf, transactionIdOf, amountCentsOf, currencyOf, type AmountCheck } from '../../shared/payments/paystack-payload.util.js';
import { reuseCutoff, reuseEndsAt, PENDING_CHECKOUT_REUSE_MS } from '../../shared/payments/pending-checkout.util.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import { recordAmountMismatch, recordDuplicatePayment, formatRand } from '../payment-reconciliation/payment-mismatch.util.js';
import { withPaymentContext } from '../payment-webhook/payment-context.util.js';
import { type WebhookContext, type HandlerResult } from '../payment-webhook/payment-webhook.types.js';
import { subscriptionRepository } from './subscription.repository.js';
import { resolveEffectiveTier } from './effective-tier.util.js';
import { resolveLatestSubscriptionPayment } from './latest-subscription-payment.util.js';
import { resolveTenantPlan } from '../subscription-tier-config/effective-plan.util.js';
import {
  getPlanCode,
  resolveTierAndPeriodFromPlanCode,
  SUBSCRIPTION_PRICES_CENTS,
  isPaidTier,
  type PaidSubscriptionTier,
} from './subscription-plans.config.js';
import {
  type SubscribeDto,
  type ChangeTierDto,
  type SubscriptionStatusDto,
  type CheckoutResult,
  type ChangeTierResult,
  type SubscriptionPricingDto,
} from './subscription.types.js';

const generateSubscribeReference = (): string => `sub_${crypto.randomBytes(16).toString('hex')}`;
// A plan change's pending attempt (payments release 1): not a Paystack
// reference (createSubscription takes none), only the marker that says
// "this tenant asked for this plan; its subscription.create is expected".
const generateUpgradeMarker = (): string => `upg_${crypto.randomBytes(16).toString('hex')}`;
const isUpgradeMarker = (reference: string | null): boolean => reference?.startsWith('upg_') ?? false;

const TIER_RANK: Record<SubscriptionTier, number> = { SPARK: 0, CELEBRATE: 1, ELEVATE: 2 };
const PERIOD_RANK: Record<SubscriptionPeriod, number> = { MONTHLY: 0, ANNUAL: 1 };
const TIER_LABEL: Record<SubscriptionTier, string> = { SPARK: 'Spark', CELEBRATE: 'Celebrate', ELEVATE: 'Elevate' };
const PERIOD_LABEL: Record<SubscriptionPeriod, string> = { MONTHLY: 'monthly', ANNUAL: 'annual' };

// Only a paid standard tier can be bought: Celebrate or Elevate, monthly or
// annual. Anything else (Spark, a custom tier's id or name, a typo) is 422
// SUBSCRIPTION_PLAN_UNKNOWN before anything is saved or Paystack is called:
// custom tiers are invoiced outside the app and never sold here.
export const SUBSCRIPTION_PLAN_UNKNOWN = 'SUBSCRIPTION_PLAN_UNKNOWN';
const PAID_PERIODS: readonly SubscriptionPeriod[] = ['MONTHLY', 'ANNUAL'];

export const parsePlanChoice = (body: unknown): SubscribeDto => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const tier = b['tier'];
  const period = b['period'];
  if (typeof tier !== 'string' || !isPaidTier(tier as SubscriptionTier) || typeof period !== 'string' || !PAID_PERIODS.includes(period as SubscriptionPeriod)) {
    throw new HttpError(422, 'Choose Celebrate or Elevate, monthly or annual.', SUBSCRIPTION_PLAN_UNKNOWN);
  }
  return { tier: tier as PaidSubscriptionTier, period: period as SubscriptionPeriod };
};

const priceOf = (tier: SubscriptionTier | null, period: SubscriptionPeriod | null): number | null =>
  tier && period && isPaidTier(tier) ? SUBSCRIPTION_PRICES_CENTS[tier][period] : null;

const planCodeOf = (data: Record<string, unknown>): string | null => {
  const plan = data['plan'];
  if (typeof plan === 'string') return plan;
  if (plan && typeof plan === 'object') {
    const code = (plan as Record<string, unknown>)['plan_code'];
    return typeof code === 'string' ? code : null;
  }
  return null;
};

const customerOf = (data: Record<string, unknown>): { customer_code?: string; email?: string } | undefined => {
  const customer = data['customer'];
  return customer && typeof customer === 'object' ? (customer as { customer_code?: string; email?: string }) : undefined;
};

type BillingTenant = NonNullable<Awaited<ReturnType<typeof subscriptionRepository.findBillingStateByTenantId>>>;

const reuseMinutes = Math.round(PENDING_CHECKOUT_REUSE_MS / 60_000);

// 409 PAYMENT_ALREADY_PENDING's details for the tenant's pending subscribe
// checkout or plan change (payment-errors.util.ts). A plan change is charged
// to the saved card: no checkout link.
const pendingSubscriptionDetails = (tenant: BillingTenant | null): PendingPurchaseDetails => {
  const tier = tenant?.subscriptionPendingTier ?? null;
  const period = tenant?.subscriptionPendingPeriod ?? null;
  const startedAt = tenant?.subscriptionPendingStartedAt ?? null;
  const isPlanChange = isUpgradeMarker(tenant?.subscriptionPendingReference ?? null);
  return {
    product: 'SUBSCRIPTION',
    purchaseId: null,
    passTier: null,
    smsCount: null,
    plan: tier && period ? { tier, period } : null,
    isPlanChange,
    amountCents: priceOf(tier, period),
    startedAt,
    canStartAnotherAt: reuseEndsAt(startedAt),
    authorizationUrl: isPlanChange ? null : tenant?.subscriptionPendingAuthorizationUrl ?? null,
  };
};

// ─────────────────────────────────────────
//  SUBSCRIPTION SERVICE
//
//  PAYSTACK MANAGES THE SCHEDULE, NOT US. This file never charges a card on
//  its own initiative — every renewal is Paystack's own scheduled action,
//  reported back by webhook (payment-webhook.service.ts's dispatch calls
//  the *WithinTransaction handlers below). The only Paystack calls this
//  file makes proactively: starting a NEW checkout (subscribe), reusing a
//  card to switch plans now (changeTier's upgrade), disabling a
//  subscription (downgrade, cancel, a refund, a duplicate), and READING
//  (verify, the sync).
//
//  Payments release 1 (see STEERING "Payments"):
//   - A subscription webhook acts only on the tenant's CURRENT subscription
//     (matched by subscription code). One about any other subscription is
//     recorded (WEBHOOK_EVENT_IGNORED) and changes nothing — a late
//     subscription.disable for an old subscription used to cancel the new
//     one.
//   - subscription.create for a tenant that already has a different live
//     subscription it didn't ask to replace is a duplicate: recorded,
//     alerted, and the extra one disabled at Paystack.
//   - Renewal failures arrive as invoice.payment_failed (and
//     invoice.update unpaid); either starts the 5-day grace. invoice.update
//     paid clears it and moves the period end.
//   - Every charge is checked for amount and currency.
//   - A second subscribe for the same plan while one is pending gets the
//     same checkout back.
//   - A plan change with no clear answer from Paystack is UNCERTAIN, never
//     FAILED, and re-checked by the sync (subscription-sync.service.ts).
// ─────────────────────────────────────────
export const subscriptionService = {
  // Read-only mirror of SUBSCRIPTION_PRICES_CENTS (the frontend reads the
  // four prices from here, never its own copy).
  getPricing: (): SubscriptionPricingDto => ({
    currency: 'ZAR',
    prices: SUBSCRIPTION_PRICES_CENTS,
  }),

  getStatus: async (tenantId: string): Promise<SubscriptionStatusDto> => {
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    const effectiveTier = resolveEffectiveTier(tenant);
    const graceDeadline = tenant.subscriptionGraceStartedAt
      ? new Date(tenant.subscriptionGraceStartedAt.getTime() + 5 * 24 * 60 * 60 * 1000)
      : null;
    // A custom tier while current: its name, description and end date, shown
    // instead of a plan to pay for (it's invoiced outside the app).
    const plan = await resolveTenantPlan(tenant);

    // The latest subscription payment's outcome (latest-subscription-payment.util.ts).
    const latestRow = await paymentLedgerRepository.findLatestSubscriptionPaymentRow(tenantId);
    const takeBacks =
      latestRow && ['SUBSCRIPTION_CHARGE_SUCCEEDED', 'PAYMENT_DUPLICATE', 'PAYMENT_AMOUNT_MISMATCH'].includes(latestRow.type)
        ? await paymentLedgerRepository.findTakeBacksFor({ reference: latestRow.paystackReference, transactionId: latestRow.paystackTransactionId })
        : [];

    return {
      customTier: plan.customTier,
      tier: effectiveTier,
      storedTier: tenant.subscriptionTier,
      period: tenant.subscriptionPeriod,
      currentPeriodEnd: tenant.subscriptionCurrentPeriodEnd,
      cancelAtPeriodEnd: tenant.subscriptionCancelAtPeriodEnd,
      pendingTierAfterPeriodEnd: tenant.subscriptionPendingTierAfterPeriodEnd,
      inGrace: effectiveTier !== 'SPARK' && tenant.subscriptionGraceStartedAt !== null,
      graceDeadline,
      pendingChange:
        tenant.subscriptionPendingReference && tenant.subscriptionPendingTier && tenant.subscriptionPendingPeriod
          ? { tier: tenant.subscriptionPendingTier, period: tenant.subscriptionPendingPeriod, startedAt: tenant.subscriptionPendingStartedAt }
          : null,
      latestPayment: resolveLatestSubscriptionPayment(latestRow, takeBacks, tenant),
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
  // picks a tier+period and is sent to Paystack to authorise a card. The
  // tier does NOT change here — only on the subscription.create webhook (or
  // the verify fallback / sync, which read Paystack directly).
  //
  // Uses the TENANT's own billing email (Tenant.email), never the admin's
  // login email: subscription.create is matched to a tenant by it.
  //
  // Payments release 1: the pending attempt is claimed, not overwritten. The
  // same plan again within the reuse window gets the same checkout link
  // (`reused: true`); another plan is 409 PAYMENT_ALREADY_PENDING.
  subscribe: async (tenantId: string, body: SubscribeDto, callbackUrl: string): Promise<CheckoutResult> => {
    const dto = parsePlanChoice(body);
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    const hasActiveSubscription = tenant.paystackSubscriptionCode && !tenant.subscriptionCancelAtPeriodEnd && tenant.subscriptionTier !== 'SPARK';
    if (hasActiveSubscription) {
      throw new HttpError(409, 'This tenant already has an active subscription. Use the change-tier endpoint to switch plans instead.');
    }

    const amountCents = SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period];
    const reference = generateSubscribeReference();
    const claimed = await subscriptionRepository.claimPendingAttempt(tenantId, { reference, tier: dto.tier, period: dto.period }, reuseCutoff());
    if (!claimed) {
      const current = await subscriptionRepository.findBillingStateByTenantId(tenantId);
      if (
        current &&
        !isUpgradeMarker(current.subscriptionPendingReference) &&
        current.subscriptionPendingTier === dto.tier &&
        current.subscriptionPendingPeriod === dto.period
      ) {
        if (!current.subscriptionPendingAuthorizationUrl) throw new HttpError(409, PAYMENT_IN_PROGRESS_MESSAGE, PAYMENT_IN_PROGRESS);
        return { authorizationUrl: current.subscriptionPendingAuthorizationUrl, reused: true };
      }
      const pendingLabel = current?.subscriptionPendingTier && current.subscriptionPendingPeriod
        ? `${TIER_LABEL[current.subscriptionPendingTier]} (${PERIOD_LABEL[current.subscriptionPendingPeriod]})`
        : 'another plan';
      throw alreadyPendingError(
        `You've already started paying for ${pendingLabel}. Finish that payment, or choose again after ${reuseMinutes} minutes.`,
        pendingSubscriptionDetails(current)
      );
    }

    await paymentLedgerService.record({
      type: 'SUBSCRIPTION_CHARGE_INITIATED',
      amountCents,
      currency: 'ZAR',
      tenantId,
      paystackReference: reference,
      relatedType: 'Tenant',
      relatedId: tenantId,
      payload: { tier: dto.tier, period: dto.period } as unknown as Prisma.InputJsonValue,
    });

    try {
      const result = await paystackClient.initializeTransaction({
        email: tenant.email,
        amountCents,
        currency: 'ZAR',
        reference,
        callbackUrl,
        // Card only — instant EFT cannot do unattended recurring charges.
        channels: ['card'],
        plan: getPlanCode(dto.tier, dto.period),
      });
      await subscriptionRepository.savePendingAuthorizationUrl(tenantId, reference, result.authorizationUrl);
      return { authorizationUrl: result.authorizationUrl, reused: false };
    } catch (err) {
      const failure = describePaystackFailure(err);
      console.error(
        `[subscription] checkout initialization failed — tenant ${tenantId}, ref ${reference}, plan ${dto.tier}/${dto.period}:`,
        err
      );
      // Safe even when uncertain: without the link nobody can pay it.
      await subscriptionRepository.clearPendingAttempt(tenantId, undefined, reference);
      await paymentLedgerService.record({
        type: 'SUBSCRIPTION_CHARGE_FAILED',
        amountCents,
        currency: 'ZAR',
        tenantId,
        paystackReference: reference,
        relatedType: 'Tenant',
        relatedId: tenantId,
        payload: { stage: 'initialize', kind: failure.kind, summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
      });
      throw toPaymentHttpError(failure, 'Something went wrong while starting this subscription. Please try again, or contact support if this keeps happening.');
    }
  },

  // ── CHANGE TIER — upgrade/downgrade between Celebrate and Elevate, and
  // monthly<->annual. Paystack has no proration: an UPGRADE in value takes
  // effect now (old subscription disabled, new one created on the saved
  // card at full price); a DOWNGRADE takes effect at period end (old one
  // disabled, access continues until subscriptionCurrentPeriodEnd).
  //
  // Payments release 1: an upgrade first records the plan it expects
  // (a pending attempt with an upg_ marker), so its subscription.create is
  // recognised and anything else is a duplicate. A createSubscription that
  // gets no clear answer (timeout, network, 5xx) may have charged: it is
  // recorded as SUBSCRIPTION_CHARGE_UNCERTAIN, the tenant is flagged for
  // the sync, and the answer is `pending_confirmation`, never FAILED.
  changeTier: async (tenantId: string, body: ChangeTierDto): Promise<ChangeTierResult> => {
    const dto: ChangeTierDto = parsePlanChoice(body);
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
      const marker = generateUpgradeMarker();
      const claimed = await subscriptionRepository.claimPendingAttempt(tenantId, { reference: marker, tier: dto.tier, period: dto.period }, reuseCutoff());
      if (!claimed) {
        throw alreadyPendingError(
          `A plan change is already being confirmed. Please wait a few minutes, then check your plan before trying again.`,
          pendingSubscriptionDetails(await subscriptionRepository.findBillingStateByTenantId(tenantId))
        );
      }

      try {
        await paystackClient.disableSubscription(tenant.paystackSubscriptionCode, tenant.paystackSubscriptionEmailToken);
      } catch (err) {
        // If Paystack can't disable the old one, creating a new one would
        // risk two active subscriptions: refuse.
        const failure = describePaystackFailure(err);
        console.error(`[subscription] disable-before-upgrade failed — tenant ${tenantId}, target ${dto.tier}/${dto.period}:`, err);
        await subscriptionRepository.clearPendingAttempt(tenantId, undefined, marker);
        if (isUncertainPaystackFailure(err)) await subscriptionRepository.markNeedsSync(tenantId);
        throw toPaymentHttpError(failure, 'Could not update the existing subscription.');
      }

      const amountCents = SUBSCRIPTION_PRICES_CENTS[dto.tier][dto.period];
      try {
        const created = await paystackClient.createSubscription({
          customerCode: tenant.paystackCustomerCode,
          planCode: getPlanCode(dto.tier, dto.period),
          ...(tenant.paystackAuthorizationCode !== null && { authorizationCode: tenant.paystackAuthorizationCode }),
        });

        await paymentLedgerService.record({
          type: 'SUBSCRIPTION_CHARGE_INITIATED',
          amountCents,
          currency: 'ZAR',
          tenantId,
          paystackReference: created.subscriptionCode,
          relatedType: 'Tenant',
          relatedId: tenantId,
          payload: { tier: dto.tier, period: dto.period, upgrade: true } as unknown as Prisma.InputJsonValue,
        });

        // The tier flip waits for subscription.create (or the sync): this
        // succeeding means Paystack ACCEPTED the request.
        return { outcome: 'accepted' };
      } catch (err) {
        const failure = describePaystackFailure(err);
        if (isUncertainPaystackFailure(err)) {
          console.error(`[subscription] upgrade outcome uncertain — tenant ${tenantId}, target ${dto.tier}/${dto.period}:`, err);
          await subscriptionRepository.markNeedsSync(tenantId);
          await paymentLedgerService.record({
            type: 'SUBSCRIPTION_CHARGE_UNCERTAIN',
            amountCents,
            currency: 'ZAR',
            tenantId,
            relatedType: 'Tenant',
            relatedId: tenantId,
            payload: { stage: 'upgrade', tier: dto.tier, period: dto.period, kind: failure.kind, summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
          });
          return { outcome: 'pending_confirmation' };
        }
        console.error(`[subscription] upgrade charge failed — tenant ${tenantId}, target ${dto.tier}/${dto.period}:`, err);
        await subscriptionRepository.clearPendingAttempt(tenantId, undefined, marker);
        await paymentLedgerService.record({
          type: 'SUBSCRIPTION_CHARGE_FAILED',
          amountCents,
          currency: 'ZAR',
          tenantId,
          relatedType: 'Tenant',
          relatedId: tenantId,
          payload: { stage: 'upgrade', kind: failure.kind, summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
        });
        throw toPaymentHttpError(failure, 'Could not start the new plan. Please contact support.');
      }
    }

    // Downgrade — deferred to period end.
    try {
      await paystackClient.disableSubscription(tenant.paystackSubscriptionCode, tenant.paystackSubscriptionEmailToken);
    } catch (err) {
      const failure = describePaystackFailure(err);
      console.error(`[subscription] downgrade-disable failed — tenant ${tenantId}, target ${dto.tier}/${dto.period}:`, err);
      if (isUncertainPaystackFailure(err)) await subscriptionRepository.markNeedsSync(tenantId);
      throw toPaymentHttpError(failure, 'Could not schedule this downgrade.');
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

  // ── UPDATE CARD LINK — Paystack's own hosted page for replacing the card
  // on the current subscription.
  getUpdateCardLink: async (tenantId: string): Promise<{ link: string }> => {
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    if (!tenant.paystackSubscriptionCode) {
      throw new HttpError(422, 'This tenant has no subscription to update a card for.');
    }

    try {
      const link = await paystackClient.generateSubscriptionManageLink(tenant.paystackSubscriptionCode);
      return { link };
    } catch (err) {
      const failure = describePaystackFailure(err);
      console.error(`[subscription] update-card-link failed — tenant ${tenantId}:`, err);
      throw toPaymentHttpError(failure, 'Could not generate a card update link. Please try again.');
    }
  },

  // ── CANCEL — same mechanism as a downgrade, target tier SPARK.
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
      const failure = describePaystackFailure(err);
      console.error(`[subscription] cancel failed — tenant ${tenantId}:`, err);
      if (isUncertainPaystackFailure(err)) await subscriptionRepository.markNeedsSync(tenantId);
      throw toPaymentHttpError(failure, 'Could not cancel this subscription.');
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

  // ── VERIFY — the billing callback page's fallback (payments release 1).
  // Asks Paystack about this tenant's pending checkout (or plan change)
  // instead of waiting for the webhook, and applies what Paystack confirms
  // through the same handlers. Then answers with the current status.
  verify: async (tenantId: string): Promise<SubscriptionStatusDto> => {
    const tenant = await subscriptionRepository.findBillingStateByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    try {
      const reference = tenant.subscriptionPendingReference;
      if (reference && !isUpgradeMarker(reference)) {
        await subscriptionService.checkPendingCheckout(tenant, reference);
      }
      const fresh = await subscriptionRepository.findBillingStateByTenantId(tenantId);
      if (fresh && (fresh.subscriptionNeedsSync || isUpgradeMarker(fresh.subscriptionPendingReference))) {
        // Imported lazily: the sync imports this file.
        const { subscriptionSyncService } = await import('./subscription-sync.service.js');
        await subscriptionSyncService.syncTenant(fresh);
      }
    } catch (err) {
      if (err instanceof PaystackApiError) {
        console.error(`[subscription] verify failed — tenant ${tenantId}:`, err);
        throw new HttpError(503, PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
      }
      throw err;
    }

    return subscriptionService.getStatus(tenantId);
  },

  // A first-subscribe checkout, checked with Paystack: paid is recorded
  // (Path A of the charge handler) and the subscription Paystack made for
  // it is looked up and activated, if its subscription.create hasn't come.
  // Not paid: left alone (the stale sweep clears it after a day). Used by
  // verify and by the stale sweep. Throws PaystackApiError when Paystack
  // can't be asked.
  checkPendingCheckout: async (tenant: BillingTenant, reference: string): Promise<'paid' | 'not_paid' | 'unknown_reference'> => {
    let verified: paystackClient.VerifyTransactionResult;
    try {
      verified = await paystackClient.verifyTransaction(reference);
    } catch (err) {
      if (err instanceof PaystackApiError && err.kind === 'rejected') return 'unknown_reference';
      throw err;
    }
    if (verified.status !== 'success') return 'not_paid';

    await withPaymentContext('verify', verified.raw, (ctx) => subscriptionService.handleChargeSuccessWithinTransaction(ctx));
    const customerCode = customerOf(verified.raw)?.customer_code;
    if (customerCode) {
      const { subscriptionSyncService } = await import('./subscription-sync.service.js');
      const fresh = await subscriptionRepository.findBillingStateByTenantId(tenant.id);
      if (fresh) await subscriptionSyncService.adoptUnseenSubscription(fresh, customerCode);
    }
    return 'paid';
  },

  // ── WEBHOOK: charge.success ──
  //
  // Path A — the tenant's own pending first-subscribe attempt, by OUR
  // reference: payment confirmed (the tier flip waits for subscription.create).
  // Path B — a renewal or an upgrade's charge, by customer code: confirm
  // payment, clear grace, and refresh the period end after commit.
  //
  // Payments release 1: amount and currency are checked first (Path A
  // against the pending plan's price; Path B against the plan named in the
  // charge, else the tenant's current or pending plan). A mismatch grants
  // nothing (no grace cleared) and is recorded and alerted. A redelivery
  // with different bytes writes nothing twice (existsFor). Paystack's
  // transaction id and paid_at go on the ledger row.
  handleChargeSuccessWithinTransaction: async (ctx: WebhookContext): Promise<HandlerResult> => {
    const { tx, data } = ctx;
    const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
    const customer = customerOf(data);
    const transactionId = transactionIdOf(data);
    const occurredAt = paidAtOf(data);
    const amountCents = amountCentsOf(data) ?? 0;

    // Path A — the tenant's own pending first-subscribe attempt.
    if (reference) {
      const pending = await subscriptionRepository.findByPendingReference(reference, tx);
      if (pending) {
        if (await paymentLedgerRepository.existsFor('SUBSCRIPTION_CHARGE_SUCCEEDED', { reference, transactionId }, tx)) {
          return { claimed: true };
        }
        const expected = priceOf(pending.subscriptionPendingTier, pending.subscriptionPendingPeriod);
        const check: AmountCheck = expected === null ? { ok: true } : checkAmount(data, expected);
        if (!check.ok) {
          await recordAmountMismatch(ctx, {
            product: 'SUBSCRIPTION',
            reference,
            transactionId,
            tenantId: pending.id,
            eventId: null,
            relatedType: 'Tenant',
            relatedId: pending.id,
            check,
          });
          return { claimed: true };
        }
        if (customer?.customer_code) {
          await subscriptionRepository.recordChargeSucceededPreliminary(pending.id, { customerCode: customer.customer_code }, tx);
        }
        await paymentLedgerService.record(
          {
            type: 'SUBSCRIPTION_CHARGE_SUCCEEDED',
            amountCents,
            currency: currencyOf(data) ?? 'ZAR',
            tenantId: pending.id,
            paystackReference: reference,
            paystackTransactionId: transactionId,
            relatedType: 'Tenant',
            relatedId: pending.id,
            ...(occurredAt && { occurredAt }),
            payload: data as unknown as Prisma.InputJsonValue,
          },
          tx
        );
        return { claimed: true };
      }
    }

    // Path B — an ongoing subscription's renewal, or an upgrade's charge.
    if (customer?.customer_code) {
      const tenant = await subscriptionRepository.findByCustomerCode(customer.customer_code, tx);
      if (tenant) {
        if (await paymentLedgerRepository.existsFor('SUBSCRIPTION_CHARGE_SUCCEEDED', { reference, transactionId }, tx)) {
          return { claimed: true };
        }

        // A second payment on one subscription period (follow-ups to
        // payments release 1): one of OUR subscribe checkouts, no longer the
        // pending one, paid after a newer payment was recorded while the
        // tenant is on a paid plan (an abandoned checkout paid late). Nothing
        // is granted, grace and the period end are left alone; recorded and
        // alerted for a refund. (A checkout whose subscription.create came
        // before its charge has no payment recorded after it: not this.)
        if (reference && tenant.paystackSubscriptionCode && tenant.subscriptionTier !== 'SPARK') {
          const initiated = await paymentLedgerRepository.findSubscribeInitiated(reference, tx);
          const newer = initiated ? await paymentLedgerRepository.findSubscriptionSuccessSince(tenant.id, initiated.createdAt, tx) : null;
          if (initiated && newer) {
            if (!(await paymentLedgerRepository.existsFor('PAYMENT_DUPLICATE', { reference, transactionId }, tx))) {
              await recordDuplicatePayment(ctx, {
                product: 'SUBSCRIPTION',
                reference,
                transactionId,
                tenantId: tenant.id,
                eventId: null,
                relatedType: 'Tenant',
                relatedId: tenant.id,
                amountCents,
                currency: currencyOf(data) ?? 'ZAR',
                ...(occurredAt && { occurredAt }),
                duplicates: {
                  reference: newer.paystackReference,
                  relatedId: newer.id,
                  description: `the ${TIER_LABEL[tenant.subscriptionTier]} subscription's current period`,
                },
              });
            }
            return { claimed: true };
          }
        }

        const planCode = planCodeOf(data);
        const planned = planCode ? resolveTierAndPeriodFromPlanCode(planCode) : null;
        const candidates = planned
          ? [priceOf(planned.tier, planned.period)]
          : [priceOf(tenant.subscriptionTier, tenant.subscriptionPeriod), priceOf(tenant.subscriptionPendingTier, tenant.subscriptionPendingPeriod)];
        const expectedPrices = candidates.filter((p): p is number => p !== null);
        const checks = expectedPrices.map((price) => checkAmount(data, price));
        const passed = expectedPrices.length === 0 || checks.some((c) => c.ok);
        if (!passed) {
          const failed = checks[0] as Extract<AmountCheck, { ok: false }>;
          await recordAmountMismatch(ctx, {
            product: 'SUBSCRIPTION',
            reference,
            transactionId,
            tenantId: tenant.id,
            eventId: null,
            relatedType: 'Tenant',
            relatedId: tenant.id,
            check: failed,
          });
          return { claimed: true };
        }

        await subscriptionRepository.recordChargeSucceededPreliminary(tenant.id, { customerCode: customer.customer_code }, tx);
        await paymentLedgerService.record(
          {
            type: 'SUBSCRIPTION_CHARGE_SUCCEEDED',
            amountCents,
            currency: currencyOf(data) ?? 'ZAR',
            tenantId: tenant.id,
            paystackReference: reference,
            paystackTransactionId: transactionId,
            relatedType: 'Tenant',
            relatedId: tenant.id,
            ...(occurredAt && { occurredAt }),
            payload: data as unknown as Prisma.InputJsonValue,
          },
          tx
        );

        // A renewal of the CURRENT plan: the new period end comes from
        // Paystack after commit. Flagged first, inside the transaction, so
        // that if the fetch fails (or the process dies) the sync picks it up
        // and the hard stop waits. An upgrade's charge (another plan) gets
        // its period end from its own subscription.create instead.
        const isCurrentPlan = !planned || (planned.tier === tenant.subscriptionTier && planned.period === tenant.subscriptionPeriod);
        if (tenant.paystackSubscriptionCode && isCurrentPlan) {
          const subscriptionCode = tenant.paystackSubscriptionCode;
          await subscriptionRepository.markNeedsSync(tenant.id, tx);
          ctx.after(async () => {
            try {
              const fresh = await paystackClient.getSubscription(subscriptionCode);
              await subscriptionRepository.updateCurrentPeriodEnd(tenant.id, new Date(fresh.nextPaymentDate));
            } catch (err) {
              // Left flagged: the hourly sync fetches it.
              console.error('[subscription webhook] could not refresh next_payment_date; left for the sync:', err);
            }
          });
        }
        return { claimed: true };
      }
    }

    return { claimed: false };
  },

  // ── WEBHOOK: charge.failed ── starts (or leaves alone, if already
  // started) the 5-day grace clock for a known customer; clears a failed
  // first-subscribe attempt.
  handleChargeFailedWithinTransaction: async (ctx: WebhookContext): Promise<HandlerResult> => {
    const { tx, data } = ctx;
    const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
    const customer = customerOf(data);
    const amountCents = amountCentsOf(data) ?? 0;

    let tenantId: string | null = null;

    if (reference) {
      const pending = await subscriptionRepository.findByPendingReference(reference, tx);
      if (pending) {
        tenantId = pending.id;
        await subscriptionRepository.clearPendingAttempt(pending.id, tx, reference);
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
        currency: currencyOf(data) ?? 'ZAR',
        tenantId,
        paystackReference: reference,
        paystackTransactionId: transactionIdOf(data),
        relatedType: 'Tenant',
        relatedId: tenantId,
        payload: data as unknown as Prisma.InputJsonValue,
      },
      tx
    );

    return { claimed: true };
  },

  // ── WEBHOOK: subscription.create ── the authoritative activation point
  // for a new subscription (first subscribe, or an upgrade). Matched by the
  // customer's email against Tenant.email (it carries no reference of ours).
  //
  // Payments release 1:
  //   - a redelivery for the tenant's current subscription changes nothing;
  //   - the plan's amount (when the payload carries it) must be our price
  //     for that plan, or nothing is activated (recorded and alerted);
  //   - a tenant with a different LIVE subscription that it didn't ask to
  //     replace (no pending attempt for this plan) gets a duplicate: recorded,
  //     alerted, and the new, extra subscription disabled at Paystack after
  //     commit, so it never renews (its first charge needs a refund);
  //   - activating over a refunded subscription still waiting to be
  //     disabled disables that old one after commit.
  handleSubscriptionCreateWithinTransaction: async (ctx: WebhookContext): Promise<HandlerResult> => {
    const { tx, data } = ctx;
    const customer = customerOf(data);
    if (!customer?.email) return { claimed: false };

    const tenant = await subscriptionRepository.findByEmail(normalizeEmail(customer.email), tx);
    if (!tenant) return { claimed: false };

    const subscriptionCode = data['subscription_code'];
    const emailToken = data['email_token'];
    const nextPaymentDate = data['next_payment_date'];
    if (typeof subscriptionCode !== 'string' || typeof emailToken !== 'string' || typeof nextPaymentDate !== 'string') {
      console.error('[subscription webhook] subscription.create missing required fields');
      return { claimed: false };
    }

    if (tenant.paystackSubscriptionCode === subscriptionCode) return { claimed: true };

    const planCode = planCodeOf(data);
    const resolved = planCode ? resolveTierAndPeriodFromPlanCode(planCode) : null;
    if (!resolved) {
      console.error('[subscription webhook] subscription.create with an unrecognised plan code:', planCode);
      return { claimed: false };
    }

    const plan = data['plan'];
    const planAmount = plan && typeof plan === 'object' ? (plan as Record<string, unknown>)['amount'] : undefined;
    if (typeof planAmount === 'number') {
      const planData = { amount: planAmount, currency: (plan as Record<string, unknown>)['currency'] ?? 'ZAR' };
      const check = checkAmount(planData, SUBSCRIPTION_PRICES_CENTS[resolved.tier][resolved.period]);
      if (!check.ok) {
        await recordAmountMismatch(ctx, {
          product: 'SUBSCRIPTION',
          reference: subscriptionCode,
          transactionId: null,
          tenantId: tenant.id,
          eventId: null,
          relatedType: 'Tenant',
          relatedId: tenant.id,
          check,
        });
        return { claimed: true };
      }
    }

    const liveOther =
      tenant.paystackSubscriptionCode !== null &&
      !tenant.subscriptionCancelAtPeriodEnd &&
      tenant.subscriptionTier !== 'SPARK';
    const expected =
      tenant.subscriptionPendingTier === resolved.tier && tenant.subscriptionPendingPeriod === resolved.period;

    if (liveOther && !expected) {
      await paymentLedgerService.record(
        {
          type: 'SUBSCRIPTION_DUPLICATE_DETECTED',
          amountCents: SUBSCRIPTION_PRICES_CENTS[resolved.tier][resolved.period],
          currency: 'ZAR',
          tenantId: tenant.id,
          paystackReference: subscriptionCode,
          relatedType: 'Tenant',
          relatedId: tenant.id,
          payload: {
            current: { subscriptionCode: tenant.paystackSubscriptionCode, tier: tenant.subscriptionTier, period: tenant.subscriptionPeriod },
            extra: { subscriptionCode, tier: resolved.tier, period: resolved.period },
            provider: ctx.payload,
          } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
      ctx.after(async () => {
        let disabled = false;
        try {
          await paystackClient.disableSubscription(subscriptionCode, emailToken);
          disabled = true;
        } catch (err) {
          console.error(`[subscription webhook] could not disable duplicate subscription ${subscriptionCode}:`, err);
        }
        await paymentAlertService.send({
          kind: 'DUPLICATE_SUBSCRIPTION',
          subject: 'A tenant was given a second subscription',
          lines: [
            `Paystack created a ${TIER_LABEL[resolved.tier]} (${PERIOD_LABEL[resolved.period]}) subscription for a tenant that already has a live subscription it didn't ask to replace.`,
            disabled
              ? "The extra subscription has been disabled so it won't renew. Its first charge has probably been taken: refund it from Paystack's dashboard."
              : "The extra subscription could NOT be disabled. Disable it in Paystack's dashboard and refund its first charge.",
          ],
          facts: [`Tenant: ${tenant.id}`, `Kept: ${tenant.paystackSubscriptionCode}`, `Extra: ${subscriptionCode}`],
        });
      });
      return { claimed: true };
    }

    // A refunded subscription still waiting to be disabled: disable it now
    // that a new one replaces it.
    const refundedLeftover =
      tenant.subscriptionTier === 'SPARK' && tenant.paystackSubscriptionCode && tenant.paystackSubscriptionEmailToken
        ? { code: tenant.paystackSubscriptionCode, token: tenant.paystackSubscriptionEmailToken }
        : null;

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

    if (refundedLeftover && refundedLeftover.code !== subscriptionCode) {
      ctx.after(async () => {
        try {
          await paystackClient.disableSubscription(refundedLeftover.code, refundedLeftover.token);
        } catch (err) {
          console.error(`[subscription webhook] could not disable refunded subscription ${refundedLeftover.code}:`, err);
          await paymentAlertService.send({
            kind: 'SYNC',
            subject: 'A refunded subscription could not be disabled',
            lines: ["Disable it in Paystack's dashboard so it doesn't renew."],
            facts: [`Tenant: ${tenant.id}`, `Subscription: ${refundedLeftover.code}`],
          });
        }
      });
    }

    return { claimed: true };
  },

  // ── WEBHOOK: subscription.disable / subscription.not_renew ──
  //
  // Payments release 1: acts ONLY when the webhook's subscription_code is
  // the tenant's current subscription. Anything else (the old subscription
  // after an upgrade or a resubscribe, delivered late) is recorded as
  // WEBHOOK_EVENT_IGNORED and changes nothing. For the current one: a
  // refunded subscription now disabled has its codes cleared; otherwise
  // access continues to the period end (cancelAtPeriodEnd).
  handleSubscriptionDisableWithinTransaction: async (ctx: WebhookContext): Promise<HandlerResult> => {
    const { tx, data } = ctx;
    const subscriptionCode = typeof data['subscription_code'] === 'string' ? data['subscription_code'] : null;
    const tenant = subscriptionCode ? await subscriptionRepository.findBySubscriptionCode(subscriptionCode, tx) : null;

    if (!tenant) {
      const customer = customerOf(data);
      const byEmail = customer?.email ? await subscriptionRepository.findByEmail(normalizeEmail(customer.email), tx) : null;
      if (!byEmail) return { claimed: false };
      await paymentLedgerService.record(
        {
          type: 'WEBHOOK_EVENT_IGNORED',
          amountCents: 0,
          currency: 'ZAR',
          tenantId: byEmail.id,
          paystackReference: subscriptionCode,
          relatedType: 'webhook',
          relatedId: ctx.event,
          payload: {
            reason: 'NOT_CURRENT_SUBSCRIPTION',
            currentSubscriptionCode: byEmail.paystackSubscriptionCode,
            provider: ctx.payload,
          } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
      return { claimed: true };
    }

    if (tenant.subscriptionTier === 'SPARK') {
      // Refunded (or otherwise ended): Paystack has now disabled it.
      await subscriptionRepository.clearSubscriptionCodes(tenant.id, tenant.paystackSubscriptionCode as string, tx);
      return { claimed: true };
    }

    if (!tenant.subscriptionCancelAtPeriodEnd) {
      await subscriptionRepository.scheduleEndOfPeriodChange(tenant.id, tenant.subscriptionPendingTierAfterPeriodEnd, tx);
    }

    return { claimed: true };
  },

  // ── WEBHOOK: invoice.payment_failed / invoice.update ── (payments
  // release 1). Paystack reports a subscription's renewal through its
  // invoice: invoice.payment_failed when the charge fails, invoice.update
  // once the invoice is settled either way. Matched by the invoice's
  // subscription code (the current subscription only, as above).
  //   failed: the 5-day grace starts (once; a second failure doesn't move
  //           it), SUBSCRIPTION_CHARGE_FAILED recorded once per invoice.
  //   paid:   grace cleared, period end moved to Paystack's next payment
  //           date. The money itself is recorded by the renewal's
  //           charge.success, not here.
  handleInvoiceWithinTransaction: async (ctx: WebhookContext): Promise<HandlerResult> => {
    const { tx, data } = ctx;
    const subscription = data['subscription'] && typeof data['subscription'] === 'object' ? (data['subscription'] as Record<string, unknown>) : null;
    const subscriptionCode =
      (typeof subscription?.['subscription_code'] === 'string' ? (subscription['subscription_code'] as string) : null) ??
      (typeof data['subscription_code'] === 'string' ? (data['subscription_code'] as string) : null);
    const invoiceCode = typeof data['invoice_code'] === 'string' ? data['invoice_code'] : null;
    const tenant = subscriptionCode ? await subscriptionRepository.findBySubscriptionCode(subscriptionCode, tx) : null;

    if (!tenant) {
      const customer = customerOf(data);
      const byEmail = customer?.email ? await subscriptionRepository.findByEmail(normalizeEmail(customer.email), tx) : null;
      if (!byEmail) return { claimed: false };
      await paymentLedgerService.record(
        {
          type: 'WEBHOOK_EVENT_IGNORED',
          amountCents: amountCentsOf(data) ?? 0,
          currency: currencyOf(data) ?? 'ZAR',
          tenantId: byEmail.id,
          paystackReference: invoiceCode ?? subscriptionCode,
          relatedType: 'webhook',
          relatedId: ctx.event,
          payload: { reason: 'NOT_CURRENT_SUBSCRIPTION', provider: ctx.payload } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
      return { claimed: true };
    }

    const paid = data['paid'] === true || data['status'] === 'success';
    if (ctx.event === 'invoice.update' && paid) {
      await subscriptionRepository.clearGrace(tenant.id, tx);
      const next = subscription?.['next_payment_date'];
      if (typeof next === 'string' && !Number.isNaN(new Date(next).getTime())) {
        await subscriptionRepository.updateCurrentPeriodEnd(tenant.id, new Date(next), tx);
      }
      return { claimed: true };
    }

    if (ctx.event === 'invoice.update' && data['status'] !== 'failed') {
      // Neither paid nor failed (still pending): nothing to do.
      return { claimed: true };
    }

    await subscriptionRepository.recordChargeFailureIfFirst(tenant.id, tx);
    if (!(await paymentLedgerRepository.existsFor('SUBSCRIPTION_CHARGE_FAILED', { reference: invoiceCode }, tx))) {
      await paymentLedgerService.record(
        {
          type: 'SUBSCRIPTION_CHARGE_FAILED',
          amountCents: amountCentsOf(data) ?? 0,
          currency: currencyOf(data) ?? 'ZAR',
          tenantId: tenant.id,
          paystackReference: invoiceCode,
          relatedType: 'Tenant',
          relatedId: tenant.id,
          payload: { stage: 'renewal', provider: ctx.payload } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
    }
    return { claimed: true };
  },
};

// Re-exported for the refund and sync paths, which format amounts the
// same way the alerts do.
export { isPaidTier, formatRand, type PaidSubscriptionTier };
