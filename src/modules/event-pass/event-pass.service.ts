import crypto from 'crypto';
import { type Prisma, type PlatformRole, type EventPassTier, type PaymentAttemptStatus } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { describePaystackFailure, PaystackApiError } from '../../shared/payments/paystack.client.js';
import {
  toPaymentHttpError,
  alreadyPendingError,
  PAYMENT_IN_PROGRESS,
  PAYMENT_IN_PROGRESS_MESSAGE,
  PAYMENT_PROVIDER_UNAVAILABLE,
  PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE,
} from '../../shared/payments/payment-errors.util.js';
import { checkAmount, paidAtOf, transactionIdOf } from '../../shared/payments/paystack-payload.util.js';
import { lockPaymentScope, reuseCutoff, reuseEndsAt, PENDING_CHECKOUT_REUSE_MS } from '../../shared/payments/pending-checkout.util.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { eventService } from '../event/event.service.js';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { eventPassRepository, CONFIRMABLE_STATUSES } from './event-pass.repository.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { isEventPassActive, resolveEventPassExpiry } from './event-entitlement.util.js';
import { withPaymentContext, PAYMENT_TRANSACTION_OPTIONS } from '../payment-webhook/payment-context.util.js';
import { type WebhookContext } from '../payment-webhook/payment-webhook.types.js';
import { recordAmountMismatch, recordDuplicatePayment, formatRand } from '../payment-reconciliation/payment-mismatch.util.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import {
  EVENT_PASS_PRICES_CENTS,
  EVENT_PASS_TIER_RANK,
  EVENT_PASS_GRANTED_TIER,
  SMS_BUNDLE_UNIT_PRICE_CENTS,
  SMS_BUNDLE_MIN_COUNT,
  SMS_BUNDLE_MAX_COUNT,
} from './event-pass-plans.config.js';
import {
  type PurchaseEventPassDto,
  type PurchaseSmsBundleDto,
  type PassCheckoutResult,
  type EventPassStatusDto,
  type SmsBundleStatusDto,
  type EventPurchasesDto,
  type EventPassPurchaseSignalDto,
} from './event-pass.types.js';

const generatePassReference = (): string => `pass_${crypto.randomBytes(16).toString('hex')}`;
const generateSmsBundleReference = (): string => `smsb_${crypto.randomBytes(16).toString('hex')}`;

export const EVENT_PASS_TIER_UNKNOWN = 'EVENT_PASS_TIER_UNKNOWN';

const TIER_LABEL: Record<EventPassTier, string> = { SMALL: 'Small', STANDARD: 'Standard', LARGE: 'Large' };

// A pass tier from the request body: one of the three, or 422 before
// anything is saved or Paystack is called. (Before release 1 an unknown tier
// reached the price lookup and Prisma, and was a 500.)
export const parsePassTier = (body: unknown): EventPassTier => {
  const tier = body && typeof body === 'object' ? (body as Record<string, unknown>)['passTier'] : undefined;
  if (typeof tier !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_PASS_PRICES_CENTS, tier)) {
    throw new HttpError(422, 'Choose the Small, Standard or Large Event Pass.', EVENT_PASS_TIER_UNKNOWN);
  }
  return tier as EventPassTier;
};

const reuseMinutes = Math.round(PENDING_CHECKOUT_REUSE_MS / 60_000);

// A verify call that failed: Paystack unreachable or slow is a neutral 503,
// never a 500 with a raw message.
const verifyOrUnavailable = async (reference: string) => {
  try {
    return await paystackClient.verifyTransaction(reference);
  } catch (err) {
    if (err instanceof PaystackApiError) {
      console.error(`[event-pass] verify failed — ref ${reference}:`, err);
      throw new HttpError(503, PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
    }
    throw err;
  }
};

// What Paystack's verify says when a checkout was not paid: the reconcile
// records it (follow-ups to payments release 1). Anything else that isn't a
// success (ongoing, pending, processing, queued: an EFT still clearing)
// leaves the purchase PENDING.
const VERIFY_NOT_PAID_STATUSES = new Set(['failed', 'abandoned']);

// duplicate: paid, but the tenant had already paid for the same thing
// (UNDER_REVIEW, PAYMENT_DUPLICATE, alerted for a refund).
export type ConfirmOutcome = 'confirmed' | 'already_handled' | 'not_found' | 'under_review' | 'duplicate';

export const eventPassService = {
  // ── STATUS ────────────────────────────────────────────────────────

  getForEvent: async (eventId: string, role: PlatformRole, tenantId: string | null): Promise<EventPassStatusDto> => {
    const event = await eventService.getById(eventId, role, tenantId); // 404s cross-tenant
    const purchases = await eventPassRepository.findPurchasesForEvent(eventId);

    return {
      pass: event.eventPass
        ? {
            passTier: event.eventPass.passTier,
            grantedTier: EVENT_PASS_GRANTED_TIER[event.eventPass.passTier],
            purchasedAt: event.eventPass.createdAt,
          }
        : null,
      isActive: isEventPassActive(event),
      expiresAt: resolveEventPassExpiry(event.eventDays),
      purchases: purchases.map((p) => ({
        id: p.id,
        passTier: p.passTier,
        isUpgrade: p.isUpgrade,
        amountPaidCents: p.amountPaidCents,
        status: p.status,
        purchasedAt: p.purchasedAt,
        confirmedAt: p.confirmedAt,
      })),
    };
  },

  getSmsBundleForEvent: async (eventId: string, role: PlatformRole, tenantId: string | null): Promise<SmsBundleStatusDto> => {
    await eventService.getById(eventId, role, tenantId); // 404s cross-tenant
    const [purchasedTotal, purchases] = await Promise.all([
      eventPassRepository.sumPaidBundleSmsForEvent(eventId),
      eventPassRepository.findSmsBundlePurchasesForEvent(eventId),
    ]);
    // Same count sms-tier-enforcement.util.ts reads to enforce the limit
    // at send time — never re-derived differently here.
    const usedFromBundle = await smsSendLogRepository.countBundleUsedForEvent(eventId);

    return {
      purchasedTotal,
      usedFromBundle,
      remaining: Math.max(purchasedTotal - usedFromBundle, 0),
      purchases: purchases.map((p) => ({
        id: p.id,
        smsCount: p.smsCount,
        amountPaidCents: p.amountPaidCents,
        status: p.status,
        purchasedAt: p.purchasedAt,
        confirmedAt: p.confirmedAt,
      })),
    };
  },

  // Every pass and SMS bundle purchase the event has, of every status,
  // newest first (follow-ups to payments release 1): whether or not a pass
  // is active now, a refunded or reversed pass's purchases included (they
  // stay when its EventPass row is removed), and whatever the `sms` flag
  // says (a bundle bought is a payment the tenant made).
  getPurchasesForEvent: async (eventId: string, role: PlatformRole, tenantId: string | null): Promise<EventPurchasesDto> => {
    await eventService.getById(eventId, role, tenantId); // 404s cross-tenant
    const [passes, bundles] = await Promise.all([
      eventPassRepository.findPurchasesForEvent(eventId),
      eventPassRepository.findSmsBundlePurchasesForEvent(eventId),
    ]);
    return {
      passPurchases: passes.map((p) => ({
        id: p.id,
        passTier: p.passTier,
        isUpgrade: p.isUpgrade,
        amountPaidCents: p.amountPaidCents,
        currency: p.currency,
        status: p.status,
        purchasedAt: p.purchasedAt,
        confirmedAt: p.confirmedAt,
      })),
      smsBundlePurchases: bundles.map((p) => ({
        id: p.id,
        smsCount: p.smsCount,
        amountPaidCents: p.amountPaidCents,
        currency: p.currency,
        status: p.status,
        purchasedAt: p.purchasedAt,
        confirmedAt: p.confirmedAt,
      })),
    };
  },

  getTenantPurchaseSignal: async(tenantId: string): Promise<EventPassPurchaseSignalDto> => {
    const passedEventCount = await eventPassRepository.countDistinctPassedEventsForTenant(tenantId);
    return { passedEventCount, isRepeatBuyer: passedEventCount >= 2 };
  },

  // ── PURCHASE (pass) ──────────────────────────────────────────────
  //
  // Fresh purchase or upgrade — decided here, not by the caller. A
  // fresh purchase happens when the event has no CURRENTLY ACTIVE pass
  // (none at all, or a prior one has expired — expiry is NOT an
  // upgrade, it's treated as if there were nothing there, per "expiry
  // grandfathers, it does not break"). An upgrade requires a strictly
  // higher target tier than whatever is active now; same-or-lower is a
  // 409.
  //
  // Payments release 1: one pending checkout per event at a time
  // (pending-checkout.util.ts). The same tier again within the reuse window
  // gets the same checkout link back (`reused: true`); another tier is 409
  // PAYMENT_ALREADY_PENDING. The check and the new row happen under one
  // lock per event, so two clicks can't both start a checkout. Paystack is
  // called after that transaction, never inside it. The INITIATED ledger
  // row is written with the purchase row, against its id.
  purchasePass: async (
    eventId: string,
    role: PlatformRole,
    tenantId: string | null,
    dto: PurchaseEventPassDto,
    callbackUrl: string
  ): Promise<PassCheckoutResult> => {
    const passTier = parsePassTier(dto);
    const event = await eventService.getById(eventId, role, tenantId); // 404s cross-tenant
    const tenant = await tenantRepository.findById(event.tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    const currentlyActive = isEventPassActive(event);
    let isUpgrade = false;
    let amountCents = EVENT_PASS_PRICES_CENTS[passTier];

    if (currentlyActive && event.eventPass) {
      const currentTier = event.eventPass.passTier;
      if (EVENT_PASS_TIER_RANK[passTier] <= EVENT_PASS_TIER_RANK[currentTier]) {
        throw new HttpError(
          409,
          `This event already has a ${currentTier} pass. Choose a higher tier to upgrade.`
        );
      }
      isUpgrade = true;
      amountCents = EVENT_PASS_PRICES_CENTS[passTier] - EVENT_PASS_PRICES_CENTS[currentTier];
    }

    const reference = generatePassReference();
    const claim = await prisma.$transaction(async (tx) => {
      await lockPaymentScope(tx, `event-pass:${eventId}`);
      const pending = await eventPassRepository.findRecentPendingPurchase(eventId, reuseCutoff(), tx);
      if (pending) return { kind: 'existing' as const, pending };

      const purchase = await eventPassRepository.createPurchase(
        { eventId, tenantId: event.tenantId, passTier, isUpgrade, amountPaidCents: amountCents, paymentRef: reference },
        tx
      );
      await paymentLedgerService.record(
        {
          type: 'EVENT_PASS_PURCHASE_INITIATED',
          amountCents,
          currency: 'ZAR',
          tenantId: event.tenantId,
          eventId,
          paystackReference: reference,
          relatedType: 'EventPassPurchase',
          relatedId: purchase.id,
          payload: { passTier, isUpgrade } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
      return { kind: 'new' as const, purchase };
    }, PAYMENT_TRANSACTION_OPTIONS);

    if (claim.kind === 'existing') {
      const { pending } = claim;
      if (pending.passTier !== passTier) {
        throw alreadyPendingError(
          `You've already started buying the ${TIER_LABEL[pending.passTier]} pass for this event. Finish that payment, or choose again after ${reuseMinutes} minutes.`,
          {
            product: 'EVENT_PASS',
            purchaseId: pending.id,
            passTier: pending.passTier,
            smsCount: null,
            plan: null,
            isPlanChange: false,
            amountCents: pending.amountPaidCents,
            startedAt: pending.purchasedAt,
            canStartAnotherAt: reuseEndsAt(pending.purchasedAt),
            authorizationUrl: pending.authorizationUrl,
          }
        );
      }
      if (!pending.authorizationUrl) throw new HttpError(409, PAYMENT_IN_PROGRESS_MESSAGE, PAYMENT_IN_PROGRESS);
      return { authorizationUrl: pending.authorizationUrl, purchaseId: pending.id, reused: true };
    }

    const { purchase } = claim;
    try {
      // One-off — both card AND instant EFT work (unlike a subscription,
      // there is no unattended recurring charge to protect a saved card
      // for). No subaccount/split: this is EventGenie's own money, same
      // as a subscription charge.
      const result = await paystackClient.initializeTransaction({
        email: tenant.email,
        amountCents,
        currency: 'ZAR',
        reference,
        callbackUrl,
        channels: ['card', 'eft'],
      });
      await eventPassRepository.saveAuthorizationUrl(purchase.id, result.authorizationUrl);
      return { authorizationUrl: result.authorizationUrl, purchaseId: purchase.id, reused: false };
    } catch (err) {
      const failure = describePaystackFailure(err);
      console.error(`[event-pass] checkout initialization failed — event ${eventId}, ref ${reference}:`, err);
      // Safe even when the outcome is uncertain (a timeout): without the
      // checkout link nobody can pay this reference, and if Paystack ever
      // reports it paid anyway, FAILED → PAID still grants it.
      await eventPassRepository.markPurchaseFailed(reference);
      await paymentLedgerService.record({
        type: 'EVENT_PASS_PURCHASE_FAILED',
        amountCents,
        currency: 'ZAR',
        tenantId: event.tenantId,
        eventId,
        paystackReference: reference,
        relatedType: 'EventPassPurchase',
        relatedId: purchase.id,
        payload: { stage: 'initialize', kind: failure.kind, summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
      });
      throw toPaymentHttpError(failure, 'Something went wrong while starting this purchase. Please try again.');
    }
  },

  // ── PURCHASE (sms bundle) ────────────────────────────────────────
  //
  // Requires an ACTIVE pass on the event — bundles are the pass
  // feature's metered add-on. Same one-pending-checkout rule as a pass:
  // the same count again reuses the checkout, another count is 409.
  purchaseSmsBundle: async (
    eventId: string,
    role: PlatformRole,
    tenantId: string | null,
    dto: PurchaseSmsBundleDto,
    callbackUrl: string
  ): Promise<PassCheckoutResult> => {
    // 422 with the purchase form's own words (sms-bundle-purchase.ts on the
    // frontend, 1 to 5000).
    if (
      typeof dto?.smsCount !== 'number' ||
      !Number.isInteger(dto.smsCount) ||
      dto.smsCount < SMS_BUNDLE_MIN_COUNT ||
      dto.smsCount > SMS_BUNDLE_MAX_COUNT
    ) {
      throw new HttpError(
        422,
        `Enter a whole number of SMS credits from ${SMS_BUNDLE_MIN_COUNT} to ${SMS_BUNDLE_MAX_COUNT}.`
      );
    }

    const event = await eventService.getById(eventId, role, tenantId);
    if (!isEventPassActive(event)) {
      throw new HttpError(
        422,
        "SMS bundles need an active Event Pass. Buy a pass for this event first."
      );
    }
    const tenant = await tenantRepository.findById(event.tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    const smsCount = dto.smsCount;
    const amountCents = smsCount * SMS_BUNDLE_UNIT_PRICE_CENTS;
    const reference = generateSmsBundleReference();

    const claim = await prisma.$transaction(async (tx) => {
      await lockPaymentScope(tx, `sms-bundle:${eventId}`);
      const pending = await eventPassRepository.findRecentPendingSmsBundlePurchase(eventId, reuseCutoff(), tx);
      if (pending) return { kind: 'existing' as const, pending };

      const purchase = await eventPassRepository.createSmsBundlePurchase(
        { eventId, tenantId: event.tenantId, smsCount, amountPaidCents: amountCents, paymentRef: reference },
        tx
      );
      await paymentLedgerService.record(
        {
          type: 'SMS_BUNDLE_PURCHASE_INITIATED',
          amountCents,
          currency: 'ZAR',
          tenantId: event.tenantId,
          eventId,
          paystackReference: reference,
          relatedType: 'EventSmsBundlePurchase',
          relatedId: purchase.id,
          payload: { smsCount } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
      return { kind: 'new' as const, purchase };
    }, PAYMENT_TRANSACTION_OPTIONS);

    if (claim.kind === 'existing') {
      const { pending } = claim;
      if (pending.smsCount !== smsCount) {
        throw alreadyPendingError(
          `You've already started buying ${pending.smsCount} SMS credits for this event. Finish that payment, or choose again after ${reuseMinutes} minutes.`,
          {
            product: 'SMS_BUNDLE',
            purchaseId: pending.id,
            passTier: null,
            smsCount: pending.smsCount,
            plan: null,
            isPlanChange: false,
            amountCents: pending.amountPaidCents,
            startedAt: pending.purchasedAt,
            canStartAnotherAt: reuseEndsAt(pending.purchasedAt),
            authorizationUrl: pending.authorizationUrl,
          }
        );
      }
      if (!pending.authorizationUrl) throw new HttpError(409, PAYMENT_IN_PROGRESS_MESSAGE, PAYMENT_IN_PROGRESS);
      return { authorizationUrl: pending.authorizationUrl, purchaseId: pending.id, reused: true };
    }

    const { purchase } = claim;
    try {
      const result = await paystackClient.initializeTransaction({
        email: tenant.email,
        amountCents,
        currency: 'ZAR',
        reference,
        callbackUrl,
        channels: ['card', 'eft'],
      });
      await eventPassRepository.saveSmsBundleAuthorizationUrl(purchase.id, result.authorizationUrl);
      return { authorizationUrl: result.authorizationUrl, purchaseId: purchase.id, reused: false };
    } catch (err) {
      const failure = describePaystackFailure(err);
      console.error(`[event-pass] sms bundle checkout initialization failed — event ${eventId}, ref ${reference}:`, err);
      await eventPassRepository.markSmsBundlePurchaseFailed(reference);
      await paymentLedgerService.record({
        type: 'SMS_BUNDLE_PURCHASE_FAILED',
        amountCents,
        currency: 'ZAR',
        tenantId: event.tenantId,
        eventId,
        paystackReference: reference,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: purchase.id,
        payload: { stage: 'initialize', kind: failure.kind, summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
      });
      throw toPaymentHttpError(failure, 'Something went wrong while starting this purchase. Please try again.');
    }
  },

  // ── CONFIRM — pass ───────────────────────────────────────────────
  //
  // The ONE activation point, from the webhook's charge.success, a verify
  // fallback, or the stale sweep: always inside a payment transaction
  // (ctx.tx) whose post-commit work (alerts) runs after it commits.
  //
  // Payments release 1:
  //  - the row is locked first, so a webhook and a verify racing on one
  //    purchase confirm it once;
  //  - PENDING or FAILED may become PAID (a success after a failed attempt
  //    on the same checkout is still a success);
  //  - Paystack's amount and currency must be what was asked for, or the
  //    purchase goes UNDER_REVIEW, nothing is granted and the super admin is
  //    alerted;
  //  - Paystack's transaction id and paid_at are stored;
  //  - the pass only rises (eventPassRepository.confirmPurchase).
  confirmPassPurchaseWithinTransaction: async (ctx: WebhookContext, paymentRef: string): Promise<{ outcome: ConfirmOutcome }> => {
    const { tx } = ctx;
    const found = await eventPassRepository.findPurchaseByPaymentRef(paymentRef, tx);
    if (!found) return { outcome: 'not_found' };
    await tx.$queryRaw`SELECT id FROM "EventPassPurchase" WHERE id = ${found.id} FOR UPDATE`;
    const purchase = await eventPassRepository.findPurchaseByPaymentRef(paymentRef, tx);
    if (!purchase || !CONFIRMABLE_STATUSES.includes(purchase.status)) return { outcome: 'already_handled' };

    const transactionId = transactionIdOf(ctx.data);
    const check = checkAmount(ctx.data, purchase.amountPaidCents, purchase.currency);
    if (!check.ok) {
      await eventPassRepository.markPurchaseUnderReview(purchase.id, { paystackTransactionId: transactionId }, tx);
      await recordAmountMismatch(ctx, {
        product: 'EVENT_PASS',
        reference: paymentRef,
        transactionId,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        relatedType: 'EventPassPurchase',
        relatedId: purchase.id,
        check,
      });
      return { outcome: 'under_review' };
    }

    // A double payment (follow-ups to payments release 1): the event's
    // active pass already has a PAID purchase of this tier, typically an
    // abandoned checkout paid after a newer one. Nothing extra is granted.
    const occurredAtPaid = paidAtOf(ctx.data);
    const sameTier = await eventPassRepository.findPaidSameTierPurchase(purchase, tx);
    if (sameTier) {
      const pass = await eventPassRepository.findByEventId(purchase.eventId, tx);
      const days = await eventPassRepository.findEventDaysForPass(purchase.eventId, tx);
      const expiry = resolveEventPassExpiry(days);
      const passActive = pass !== null && (expiry === null || new Date() < expiry);
      if (passActive) {
        await eventPassRepository.markPurchaseUnderReview(purchase.id, { paystackTransactionId: transactionId }, tx);
        await recordDuplicatePayment(ctx, {
          product: 'EVENT_PASS',
          reference: paymentRef,
          transactionId,
          tenantId: purchase.tenantId,
          eventId: purchase.eventId,
          relatedType: 'EventPassPurchase',
          relatedId: purchase.id,
          amountCents: purchase.amountPaidCents,
          currency: purchase.currency,
          ...(occurredAtPaid && { occurredAt: occurredAtPaid }),
          duplicates: {
            reference: sameTier.paymentRef,
            relatedId: sameTier.id,
            description: `the ${TIER_LABEL[purchase.passTier]} pass for this event`,
          },
        });
        return { outcome: 'duplicate' };
      }
    }

    const result = await eventPassRepository.confirmPurchase(
      purchase,
      EVENT_PASS_TIER_RANK,
      { paystackTransactionId: transactionId },
      tx
    );

    const occurredAt = paidAtOf(ctx.data);
    await paymentLedgerService.record(
      {
        type: 'EVENT_PASS_PURCHASE_SUCCEEDED',
        amountCents: purchase.amountPaidCents,
        currency: purchase.currency,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        paystackReference: paymentRef,
        paystackTransactionId: transactionId,
        relatedType: 'EventPassPurchase',
        relatedId: purchase.id,
        ...(occurredAt && { occurredAt }),
        // passTier/isUpgrade merged in alongside the raw provider payload —
        // billing-history-presenter.util.ts reads these. tierKept: this
        // purchase was paid but the event already had an equal or higher pass.
        payload: {
          passTier: purchase.passTier,
          isUpgrade: purchase.isUpgrade,
          tierKept: result.kept,
          ...(purchase.status === 'FAILED' && { confirmedAfterFailure: true }),
          provider: ctx.payload,
        } as unknown as Prisma.InputJsonValue,
      },
      tx
    );

    if (result.kept) {
      ctx.after(async () => {
        await paymentAlertService.send({
          kind: 'REFUND',
          subject: 'An Event Pass was paid for but changed nothing',
          lines: [
            `This ${TIER_LABEL[purchase.passTier]} pass was paid after the event already had the ${TIER_LABEL[result.passTier]} pass, so the event keeps its ${TIER_LABEL[result.passTier]} pass.`,
            "The organiser has paid for nothing. Consider refunding this payment from Paystack's dashboard.",
          ],
          facts: [
            `Reference: ${paymentRef}`,
            `Amount: ${formatRand(purchase.amountPaidCents)}`,
            `Tenant: ${purchase.tenantId}`,
            `Event: ${purchase.eventId}`,
          ],
        });
      });
    }

    return { outcome: 'confirmed' };
  },

  // charge.failed: only a PENDING attempt becomes FAILED. A PAID one is
  // never downgraded.
  failPassPurchaseWithinTransaction: async (ctx: WebhookContext, paymentRef: string): Promise<{ outcome: 'failed' | 'already_handled' | 'not_found' }> => {
    const { tx } = ctx;
    const purchase = await eventPassRepository.findPurchaseByPaymentRef(paymentRef, tx);
    if (!purchase) return { outcome: 'not_found' };
    if (purchase.status !== 'PENDING') return { outcome: 'already_handled' };

    await tx.eventPassPurchase.updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { status: 'FAILED' } });

    await paymentLedgerService.record(
      {
        type: 'EVENT_PASS_PURCHASE_FAILED',
        amountCents: purchase.amountPaidCents,
        currency: purchase.currency,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        paystackReference: paymentRef,
        relatedType: 'EventPassPurchase',
        relatedId: purchase.id,
        payload: ctx.payload,
      },
      tx
    );

    return { outcome: 'failed' };
  },

  // ── CONFIRM / FAIL — sms bundle ──────────────────────────────────

  confirmSmsBundlePurchaseWithinTransaction: async (ctx: WebhookContext, paymentRef: string): Promise<{ outcome: ConfirmOutcome }> => {
    const { tx } = ctx;
    const found = await eventPassRepository.findSmsBundlePurchaseByPaymentRef(paymentRef, tx);
    if (!found) return { outcome: 'not_found' };
    await tx.$queryRaw`SELECT id FROM "EventSmsBundlePurchase" WHERE id = ${found.id} FOR UPDATE`;
    const purchase = await eventPassRepository.findSmsBundlePurchaseByPaymentRef(paymentRef, tx);
    if (!purchase || !CONFIRMABLE_STATUSES.includes(purchase.status)) return { outcome: 'already_handled' };

    const transactionId = transactionIdOf(ctx.data);
    const check = checkAmount(ctx.data, purchase.amountPaidCents, purchase.currency);
    if (!check.ok) {
      await eventPassRepository.markSmsBundleUnderReview(purchase.id, { paystackTransactionId: transactionId }, tx);
      await recordAmountMismatch(ctx, {
        product: 'SMS_BUNDLE',
        reference: paymentRef,
        transactionId,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: purchase.id,
        check,
      });
      return { outcome: 'under_review' };
    }

    // A double payment: this checkout was abandoned (FAILED) and a newer
    // bundle of the same size, started after it, is already PAID: the
    // tenant replaced it, so this late payment adds no credits. A
    // deliberate second purchase of the same size (its own checkout, never
    // FAILED) is always granted, whenever it happens.
    const sameBundle =
      purchase.status === 'FAILED' ? await eventPassRepository.findPaidNewerSameBundle(purchase, tx) : null;
    if (sameBundle) {
      const paidAt = paidAtOf(ctx.data);
      await eventPassRepository.markSmsBundleUnderReview(purchase.id, { paystackTransactionId: transactionId }, tx);
      await recordDuplicatePayment(ctx, {
        product: 'SMS_BUNDLE',
        reference: paymentRef,
        transactionId,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: purchase.id,
        amountCents: purchase.amountPaidCents,
        currency: purchase.currency,
        ...(paidAt && { occurredAt: paidAt }),
        duplicates: {
          reference: sameBundle.paymentRef,
          relatedId: sameBundle.id,
          description: `${purchase.smsCount} SMS credits for this event`,
        },
      });
      return { outcome: 'duplicate' };
    }

    await eventPassRepository.confirmSmsBundlePurchase(purchase.id, { paystackTransactionId: transactionId }, tx);

    const occurredAt = paidAtOf(ctx.data);
    await paymentLedgerService.record(
      {
        type: 'SMS_BUNDLE_PURCHASE_SUCCEEDED',
        amountCents: purchase.amountPaidCents,
        currency: purchase.currency,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        paystackReference: paymentRef,
        paystackTransactionId: transactionId,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: purchase.id,
        ...(occurredAt && { occurredAt }),
        payload: {
          smsCount: purchase.smsCount,
          ...(purchase.status === 'FAILED' && { confirmedAfterFailure: true }),
          provider: ctx.payload,
        } as unknown as Prisma.InputJsonValue,
      },
      tx
    );

    return { outcome: 'confirmed' };
  },

  failSmsBundlePurchaseWithinTransaction: async (ctx: WebhookContext, paymentRef: string): Promise<{ outcome: 'failed' | 'already_handled' | 'not_found' }> => {
    const { tx } = ctx;
    const purchase = await eventPassRepository.findSmsBundlePurchaseByPaymentRef(paymentRef, tx);
    if (!purchase) return { outcome: 'not_found' };
    if (purchase.status !== 'PENDING') return { outcome: 'already_handled' };

    await tx.eventSmsBundlePurchase.updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { status: 'FAILED' } });

    await paymentLedgerService.record(
      {
        type: 'SMS_BUNDLE_PURCHASE_FAILED',
        amountCents: purchase.amountPaidCents,
        currency: purchase.currency,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        paystackReference: paymentRef,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: purchase.id,
        payload: ctx.payload,
      },
      tx
    );

    return { outcome: 'failed' };
  },

  // ── RECONCILE — the callback page's verify fallback. Never trusts the
  // redirect: asks Paystack directly, and only a definite success goes
  // through the same confirmation (amount check included) as the webhook.
  // Gated like every other event sub-resource (STEERING "Tenant scoping").
  // Rate limited at the router.
  reconcilePassPurchase: async (
    eventId: string,
    purchaseId: string,
    role: PlatformRole,
    tenantId: string | null
  ): Promise<{ status: PaymentAttemptStatus }> => {
    await eventService.getById(eventId, role, tenantId);
    const purchase = await eventPassRepository.findPurchaseForEvent(purchaseId, eventId);
    if (!purchase) throw new HttpError(404, 'Event pass purchase not found');
    if (!CONFIRMABLE_STATUSES.includes(purchase.status) || !purchase.paymentRef) {
      return { status: purchase.status };
    }

    const verified = await verifyOrUnavailable(purchase.paymentRef);
    if (verified.status === 'success') {
      await withPaymentContext('verify', verified.raw, (ctx) =>
        eventPassService.confirmPassPurchaseWithinTransaction(ctx, purchase.paymentRef!)
      );
    } else if (VERIFY_NOT_PAID_STATUSES.has(verified.status)) {
      // Recorded as the webhook's charge.failed would be: a PENDING attempt
      // becomes FAILED with an EVENT_PASS_PURCHASE_FAILED row (a FAILED one
      // is left as it is). Still paid later, FAILED → PAID grants it.
      await withPaymentContext('verify', verified.raw, (ctx) =>
        eventPassService.failPassPurchaseWithinTransaction(ctx, purchase.paymentRef!)
      );
    } else {
      return { status: purchase.status };
    }
    const after = await eventPassRepository.findPurchaseForEvent(purchaseId, eventId);
    return { status: after?.status ?? purchase.status };
  },

  reconcileSmsBundlePurchase: async (
    eventId: string,
    purchaseId: string,
    role: PlatformRole,
    tenantId: string | null
  ): Promise<{ status: PaymentAttemptStatus }> => {
    await eventService.getById(eventId, role, tenantId);
    const purchase = await eventPassRepository.findSmsBundlePurchaseForEvent(purchaseId, eventId);
    if (!purchase) throw new HttpError(404, 'SMS bundle purchase not found');
    if (!CONFIRMABLE_STATUSES.includes(purchase.status) || !purchase.paymentRef) {
      return { status: purchase.status };
    }

    const verified = await verifyOrUnavailable(purchase.paymentRef);
    if (verified.status === 'success') {
      await withPaymentContext('verify', verified.raw, (ctx) =>
        eventPassService.confirmSmsBundlePurchaseWithinTransaction(ctx, purchase.paymentRef!)
      );
    } else if (VERIFY_NOT_PAID_STATUSES.has(verified.status)) {
      await withPaymentContext('verify', verified.raw, (ctx) =>
        eventPassService.failSmsBundlePurchaseWithinTransaction(ctx, purchase.paymentRef!)
      );
    } else {
      return { status: purchase.status };
    }
    const after = await eventPassRepository.findSmsBundlePurchaseForEvent(purchaseId, eventId);
    return { status: after?.status ?? purchase.status };
  },
};
