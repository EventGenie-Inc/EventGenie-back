import crypto from 'crypto';
import { type Prisma, type PlatformRole } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { describePaystackFailure, type PaystackFailureDescription } from '../../shared/payments/paystack.client.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { eventService } from '../event/event.service.js';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { eventPassRepository } from './event-pass.repository.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { isEventPassActive, resolveEventPassExpiry } from './event-entitlement.util.js';
import {
  EVENT_PASS_PRICES_CENTS,
  EVENT_PASS_TIER_RANK,
  EVENT_PASS_GRANTED_TIER,
  SMS_BUNDLE_UNIT_PRICE_CENTS,
} from './event-pass-plans.config.js';
import {
  type PurchaseEventPassDto,
  type PurchaseSmsBundleDto,
  type PassCheckoutResult,
  type EventPassStatusDto,
  type SmsBundleStatusDto,
  type EventPassPurchaseSignalDto,
} from './event-pass.types.js';

// Same reasoning as ticket-purchase.service.ts / payment-webhook.service.ts's
// own comment on this — a serverless Postgres connection's cold-start
// cost alone can exceed Prisma's defaults.
const NEON_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

const generatePassReference = (): string => `pass_${crypto.randomBytes(16).toString('hex')}`;
const generateSmsBundleReference = (): string => `smsb_${crypto.randomBytes(16).toString('hex')}`;

// Real Paystack rejection (bad email on file, declined card) is a 422 —
// the request shape was valid, a precondition wasn't met. Anything else
// never reached Paystack with a request at all; that's a server
// misconfiguration, a 500. Same split as subscription.service.ts's
// toSubscriptionHttpError.
const toPassHttpError = (failure: PaystackFailureDescription, fallbackMessage: string): HttpError =>
  new HttpError(failure.isPaystackRejection ? 422 : 500, failure.isPaystackRejection ? failure.summary : fallbackMessage);

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

  getTenantPurchaseSignal: async (tenantId: string): Promise<EventPassPurchaseSignalDto> => {
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
  // 409 — "buying a pass for an event that already has one" is refused
  // unless it's a genuine upgrade.
  purchasePass: async (
    eventId: string,
    role: PlatformRole,
    tenantId: string | null,
    dto: PurchaseEventPassDto,
    callbackUrl: string
  ): Promise<PassCheckoutResult> => {
    const event = await eventService.getById(eventId, role, tenantId); // 404s cross-tenant
    const tenant = await tenantRepository.findById(event.tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    const currentlyActive = isEventPassActive(event);
    let isUpgrade = false;
    let amountCents = EVENT_PASS_PRICES_CENTS[dto.passTier];

    if (currentlyActive && event.eventPass) {
      const currentTier = event.eventPass.passTier;
      if (EVENT_PASS_TIER_RANK[dto.passTier] <= EVENT_PASS_TIER_RANK[currentTier]) {
        throw new HttpError(
          409,
          `This event already has a ${currentTier} pass. Choose a higher tier to upgrade — a Small/Standard pass cannot be bought again once one is already active.`
        );
      }
      isUpgrade = true;
      amountCents = EVENT_PASS_PRICES_CENTS[dto.passTier] - EVENT_PASS_PRICES_CENTS[currentTier];
    }

    const reference = generatePassReference();
    await eventPassRepository.createPurchase({
      eventId,
      tenantId: event.tenantId,
      passTier: dto.passTier,
      isUpgrade,
      amountPaidCents: amountCents,
      paymentRef: reference,
    });

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

      await paymentLedgerService.record({
        type: 'EVENT_PASS_PURCHASE_INITIATED',
        amountCents,
        currency: 'ZAR',
        tenantId: event.tenantId,
        eventId,
        paystackReference: reference,
        relatedType: 'EventPassPurchase',
        relatedId: reference,
        payload: { passTier: dto.passTier, isUpgrade } as unknown as Prisma.InputJsonValue,
      });

      return { authorizationUrl: result.authorizationUrl };
    } catch (err) {
      const failure = describePaystackFailure(err);
      console.error(`[event-pass] checkout initialization failed — event ${eventId}, ref ${reference}:`, err);
      await eventPassRepository.markPurchaseFailed(reference);
      await paymentLedgerService.record({
        type: 'EVENT_PASS_PURCHASE_FAILED',
        amountCents,
        currency: 'ZAR',
        tenantId: event.tenantId,
        eventId,
        paystackReference: reference,
        relatedType: 'EventPassPurchase',
        relatedId: reference,
        payload: { stage: 'initialize', summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
      });
      throw toPassHttpError(failure, 'Something went wrong while starting this purchase. Please try again.');
    }
  },

  // ── PURCHASE (sms bundle) ────────────────────────────────────────
  //
  // Requires an ACTIVE pass on the event — bundles are the pass
  // feature's metered add-on. Selling one for an unpassed event would
  // be dead money: assertSmsSendable never draws from a bundle unless
  // the event currently has an active pass (see sms-tier-enforcement.util.ts).
  purchaseSmsBundle: async (
    eventId: string,
    role: PlatformRole,
    tenantId: string | null,
    dto: PurchaseSmsBundleDto,
    callbackUrl: string
  ): Promise<PassCheckoutResult> => {
    if (!Number.isInteger(dto.smsCount) || dto.smsCount <= 0) {
      throw new HttpError(400, 'smsCount must be a positive whole number.');
    }

    const event = await eventService.getById(eventId, role, tenantId);
    if (!isEventPassActive(event)) {
      throw new HttpError(
        422,
        "This event doesn't have an active Event Pass — SMS bundles are only available for events with one. Buy a pass first."
      );
    }
    const tenant = await tenantRepository.findById(event.tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    const amountCents = dto.smsCount * SMS_BUNDLE_UNIT_PRICE_CENTS;
    const reference = generateSmsBundleReference();

    await eventPassRepository.createSmsBundlePurchase({
      eventId,
      tenantId: event.tenantId,
      smsCount: dto.smsCount,
      amountPaidCents: amountCents,
      paymentRef: reference,
    });

    try {
      const result = await paystackClient.initializeTransaction({
        email: tenant.email,
        amountCents,
        currency: 'ZAR',
        reference,
        callbackUrl,
        channels: ['card', 'eft'],
      });

      await paymentLedgerService.record({
        type: 'SMS_BUNDLE_PURCHASE_INITIATED',
        amountCents,
        currency: 'ZAR',
        tenantId: event.tenantId,
        eventId,
        paystackReference: reference,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: reference,
        payload: { smsCount: dto.smsCount } as unknown as Prisma.InputJsonValue,
      });

      return { authorizationUrl: result.authorizationUrl };
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
        relatedId: reference,
        payload: { stage: 'initialize', summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
      });
      throw toPassHttpError(failure, 'Something went wrong while starting this purchase. Please try again.');
    }
  },

  // ── WEBHOOK: charge.success / charge.failed — pass ───────────────
  //
  // The ONE activation point. Never called from a guest/organiser
  // callback return — see payment-webhook.service.ts's dispatch, which
  // is the only caller. Runs inside the SAME transaction as the
  // webhook's own idempotency-guard insert, same reasoning as
  // ticket-purchase.service.ts's confirmPaymentWithinTransaction.
  confirmPassPurchaseWithinTransaction: async (
    tx: Prisma.TransactionClient,
    paymentRef: string,
    providerPayload: Prisma.InputJsonValue
  ): Promise<{ outcome: 'confirmed' | 'already_handled' | 'not_found' }> => {
    const purchase = await eventPassRepository.findPurchaseByPaymentRef(paymentRef, tx);
    if (!purchase) return { outcome: 'not_found' };
    if (purchase.status === 'PAID') return { outcome: 'already_handled' };
    if (purchase.status !== 'PENDING') return { outcome: 'already_handled' };

    await eventPassRepository.confirmPurchase(purchase, tx);

    await paymentLedgerService.record(
      {
        type: 'EVENT_PASS_PURCHASE_SUCCEEDED',
        amountCents: purchase.amountPaidCents,
        currency: purchase.currency,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        paystackReference: paymentRef,
        relatedType: 'EventPassPurchase',
        relatedId: purchase.id,
        // passTier/isUpgrade merged in alongside the raw provider
        // payload — billing-history-presenter.util.ts reads these to
        // render "Event Pass upgraded to: LARGE" rather than a bare
        // "Event Pass purchased", which the raw Paystack body alone
        // (charge/customer/authorization fields) has no way to say.
        payload: { passTier: purchase.passTier, isUpgrade: purchase.isUpgrade, provider: providerPayload } as unknown as Prisma.InputJsonValue,
      },
      tx
    );

    return { outcome: 'confirmed' };
  },

  failPassPurchaseWithinTransaction: async (
    tx: Prisma.TransactionClient,
    paymentRef: string,
    providerPayload: Prisma.InputJsonValue
  ): Promise<{ outcome: 'failed' | 'already_handled' | 'not_found' }> => {
    const purchase = await eventPassRepository.findPurchaseByPaymentRef(paymentRef, tx);
    if (!purchase) return { outcome: 'not_found' };
    if (purchase.status !== 'PENDING') return { outcome: 'already_handled' };

    await tx.eventPassPurchase.update({ where: { id: purchase.id }, data: { status: 'FAILED' } });

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
        payload: providerPayload,
      },
      tx
    );

    return { outcome: 'failed' };
  },

  // ── WEBHOOK: charge.success / charge.failed — sms bundle ─────────

  confirmSmsBundlePurchaseWithinTransaction: async (
    tx: Prisma.TransactionClient,
    paymentRef: string,
    providerPayload: Prisma.InputJsonValue
  ): Promise<{ outcome: 'confirmed' | 'already_handled' | 'not_found' }> => {
    const purchase = await eventPassRepository.findSmsBundlePurchaseByPaymentRef(paymentRef, tx);
    if (!purchase) return { outcome: 'not_found' };
    if (purchase.status !== 'PENDING') return { outcome: 'already_handled' };

    await eventPassRepository.confirmSmsBundlePurchase(purchase.id, tx);

    await paymentLedgerService.record(
      {
        type: 'SMS_BUNDLE_PURCHASE_SUCCEEDED',
        amountCents: purchase.amountPaidCents,
        currency: purchase.currency,
        tenantId: purchase.tenantId,
        eventId: purchase.eventId,
        paystackReference: paymentRef,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: purchase.id,
        // smsCount merged in alongside the raw provider payload — same
        // reasoning as confirmPassPurchaseWithinTransaction above.
        payload: { smsCount: purchase.smsCount, provider: providerPayload } as unknown as Prisma.InputJsonValue,
      },
      tx
    );

    return { outcome: 'confirmed' };
  },

  failSmsBundlePurchaseWithinTransaction: async (
    tx: Prisma.TransactionClient,
    paymentRef: string,
    providerPayload: Prisma.InputJsonValue
  ): Promise<{ outcome: 'failed' | 'already_handled' | 'not_found' }> => {
    const purchase = await eventPassRepository.findSmsBundlePurchaseByPaymentRef(paymentRef, tx);
    if (!purchase) return { outcome: 'not_found' };
    if (purchase.status !== 'PENDING') return { outcome: 'already_handled' };

    await tx.eventSmsBundlePurchase.update({ where: { id: purchase.id }, data: { status: 'FAILED' } });

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
        payload: providerPayload,
      },
      tx
    );

    return { outcome: 'failed' };
  },

  // ── RECONCILE — same "never trust the callback redirect, verify with
  // Paystack directly" pattern as ticket-purchase.service.ts's reconcile.
  // Used by the frontend's callback landing page as a fallback/status
  // check; the webhook remains the actual source of truth either way —
  // this only ever ACTS on a definitive 'success' from Paystack's own
  // verify endpoint, never on the redirect's query params.
  reconcilePassPurchase: async (purchaseId: string): Promise<{ status: 'PENDING' | 'PAID' | 'FAILED' }> => {
    const purchase = await prisma.eventPassPurchase.findFirst({ where: { id: purchaseId } });
    if (!purchase) throw new HttpError(404, 'Event pass purchase not found');
    if (purchase.status !== 'PENDING' || !purchase.paymentRef) {
      return { status: purchase.status };
    }

    const verified = await paystackClient.verifyTransaction(purchase.paymentRef);
    if (verified.status === 'success') {
      await prisma.$transaction(
        (tx) => eventPassService.confirmPassPurchaseWithinTransaction(tx, purchase.paymentRef!, verified.raw as unknown as Prisma.InputJsonValue),
        NEON_TRANSACTION_OPTIONS
      );
      return { status: 'PAID' };
    }
    return { status: 'PENDING' };
  },

  reconcileSmsBundlePurchase: async (purchaseId: string): Promise<{ status: 'PENDING' | 'PAID' | 'FAILED' }> => {
    const purchase = await prisma.eventSmsBundlePurchase.findFirst({ where: { id: purchaseId } });
    if (!purchase) throw new HttpError(404, 'SMS bundle purchase not found');
    if (purchase.status !== 'PENDING' || !purchase.paymentRef) {
      return { status: purchase.status };
    }

    const verified = await paystackClient.verifyTransaction(purchase.paymentRef);
    if (verified.status === 'success') {
      await prisma.$transaction(
        (tx) => eventPassService.confirmSmsBundlePurchaseWithinTransaction(tx, purchase.paymentRef!, verified.raw as unknown as Prisma.InputJsonValue),
        NEON_TRANSACTION_OPTIONS
      );
      return { status: 'PAID' };
    }
    return { status: 'PENDING' };
  },
};
