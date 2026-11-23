import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { prisma } from '../helpers/fixtures.js';
import { fakePaystack, type FakeSubscription } from '../helpers/fake-paystack.js';
import { sendWebhook } from '../helpers/paystack-webhook.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { subscriptionSyncService } from '../../src/modules/subscription/subscription-sync.service.js';
import { paymentReconciliationService } from '../../src/modules/payment-reconciliation/payment-reconciliation.service.js';
import { SUBSCRIPTION_PRICES_CENTS } from '../../src/modules/subscription/subscription-plans.config.js';
import { cardVerificationChargeOf, cardVerificationRefundOf } from '../../src/shared/payments/card-verification.util.js';
import { displayCardBrand } from '../../src/shared/payments/card-brand.util.js';
import {
  createPaymentsTenant,
  cleanupPayments,
  headersFor,
  installAuth,
  paymentAlerts,
  usePlanCodes,
  trackedReferences,
  type PaymentsTenant,
} from './payments-fixtures.js';

// ─────────────────────────────────────────
//  UPDATE CARD (fix/payments-go-live, ticket 8)
//
//  A tenant replaces its card on Paystack's manage page. Paystack sends no
//  subscription webhook for it: only the R1 verification charge (which dev
//  never received as a webhook) and its refund (refund.pending, then
//  refund.processed, which dev did). The card shown is read back from the
//  subscription; the R1 and its refund are card verification, never a
//  payment, a renewal, a refund of the subscription, a duplicate or a ticket
//  order. Payload shapes: the fake's updateCard, as seen on dev on 22 Nov.
// ─────────────────────────────────────────

const ELEVATE_M = SUBSCRIPTION_PRICES_CENTS.ELEVATE.MONTHLY;
const NEW_CARD = { last4: '0409', card_type: 'visa ', exp_month: '01', exp_year: '2030' };

const status = (t: PaymentsTenant) => request(app).get('/api/subscriptions').set(headersFor(t.admin));
const verify = (t: PaymentsTenant) => request(app).post('/api/subscriptions/verify').set(headersFor(t.admin));
const tenantOf = (t: PaymentsTenant) => prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
const ledgerOf = (t: PaymentsTenant) => prisma.paymentLedgerEntry.findMany({ where: { tenantId: t.tenantId }, orderBy: { createdAt: 'asc' } });

const subscribeElevate = async (t: PaymentsTenant): Promise<{ reference: string; sub: FakeSubscription }> => {
  const res = await request(app).post('/api/subscriptions/subscribe').set(headersFor(t.admin)).send({ tier: 'ELEVATE', period: 'MONTHLY' });
  expect(res.status).toBe(200);
  const reference = (res.body.data.authorizationUrl as string).split('/').pop()!;
  trackedReferences.push(reference);
  const charge = fakePaystack.pay(reference);
  const sub = fakePaystack.subscriptionFor(t.email).at(-1)!;
  await sendWebhook('charge.success', charge);
  await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(sub));
  return { reference, sub };
};

let t: PaymentsTenant;

beforeEach(async () => {
  installAuth();
  usePlanCodes();
  clearSentEmails();
  t = await createPaymentsTenant();
}, 60000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPayments();
}, 120000);

describe('the card shown after a card update', () => {
  it('the next subscription read shows the new card, once the verification refund arrives', async () => {
    const { sub } = await subscribeElevate(t);
    expect((await status(t)).body.data.card).toEqual({ brand: 'Visa', last4: '4081', expMonth: '12', expYear: '2030' });

    const { refund } = fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    // What dev received: refund.pending seconds after the charge.
    await sendWebhook('refund.pending', { ...refund, status: 'pending' });

    expect((await status(t)).body.data.card).toEqual({ brand: 'Visa', last4: '0409', expMonth: '01', expYear: '2030' });
  }, 60000);

  it('coming back from the update page, POST /verify answers with the new card (no webhook needed)', async () => {
    const { sub } = await subscribeElevate(t);
    fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    const res = await verify(t);
    expect(res.status).toBe(200);
    expect(res.body.data.card).toEqual({ brand: 'Visa', last4: '0409', expMonth: '01', expYear: '2030' });
  }, 60000);

  it('the daily sync corrects a stale card', async () => {
    const { sub } = await subscribeElevate(t);
    fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    expect((await tenantOf(t)).paystackCardLast4).toBe('4081');

    const result = await subscriptionSyncService.syncMany({ onlyFlagged: false, tenantIds: [t.tenantId] });
    expect(result).toMatchObject({ checked: 1, corrected: 1, failed: 0 });
    expect(await tenantOf(t)).toMatchObject({ paystackCardLast4: '0409', paystackCardExpMonth: '01', paystackCardExpYear: '2030', paystackCardBrand: 'Visa' });
    const corrected = (await ledgerOf(t)).find((e) => e.type === 'SUBSCRIPTION_SYNC_CORRECTED');
    expect(corrected?.payload).toMatchObject({ changes: ['CARD_UPDATED'], before: { card: { last4: '4081' } }, after: { card: { last4: '0409' } } });

    // In step now: the next sync changes nothing.
    expect(await subscriptionSyncService.syncMany({ onlyFlagged: false, tenantIds: [t.tenantId] })).toMatchObject({ corrected: 0 });
  }, 60000);
});

describe('the R1 verification charge and its refund', () => {
  it('leave the subscription ACTIVE, write no purchase or refund entries, and raise no duplicate or alert', async () => {
    const { sub } = await subscribeElevate(t);
    const before = await ledgerOf(t);
    clearSentEmails();

    const { charge, refund } = fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    expect((await sendWebhook('charge.success', charge)).status).toBe(200);
    expect((await sendWebhook('refund.pending', { ...refund, status: 'pending' })).status).toBe(200);
    expect((await sendWebhook('refund.processed', refund)).status).toBe(200);

    // Still on Elevate, with its subscription.
    const tenant = await tenantOf(t);
    expect(tenant).toMatchObject({ subscriptionTier: 'ELEVATE', paystackSubscriptionCode: sub.subscription_code, subscriptionGraceStartedAt: null });
    expect(fakePaystack.subscriptions.get(sub.subscription_code)?.status).toBe('active');
    const read = (await status(t)).body.data;
    expect(read).toMatchObject({ tier: 'ELEVATE', cancelAtPeriodEnd: false, inGrace: false, latestPayment: { status: 'PAID', amountCents: ELEVATE_M } });

    // Only card verification rows were added: no purchase, renewal, refund,
    // mismatch or duplicate.
    const added = (await ledgerOf(t)).slice(before.length);
    expect(added.map((e) => [e.type, (e.payload as { reason?: string; step?: string }).reason, (e.payload as { step?: string }).step])).toEqual([
      ['WEBHOOK_EVENT_IGNORED', 'CARD_VERIFICATION', 'CHARGE'],
      ['WEBHOOK_EVENT_IGNORED', 'CARD_VERIFICATION', 'REFUND'],
      ['WEBHOOK_EVENT_IGNORED', 'CARD_VERIFICATION', 'REFUND'],
    ]);
    const anywhere = await prisma.paymentLedgerEntry.findMany({
      where: { OR: [{ paystackReference: charge['reference'] as string }, { paystackTransactionId: String(charge['id']) }] },
    });
    expect(anywhere.every((e) => e.type === 'WEBHOOK_EVENT_IGNORED')).toBe(true);
    expect(await prisma.paymentMismatch.count({ where: { OR: [{ tenantId: t.tenantId }, { paystackReference: charge['reference'] as string }] } })).toBe(0);
    expect(paymentAlerts()).toEqual([]);

    // Billing history doesn't list them.
    const history = await request(app).get('/api/billing-history').set(headersFor(t.admin));
    expect(history.body.data.filter((h: { amountCents: number }) => h.amountCents === 100)).toEqual([]);

    // A redelivery with different bytes adds nothing.
    await sendWebhook('refund.processed', { ...refund, integration: 2 });
    expect((await ledgerOf(t)).length).toBe(before.length + 3);
  }, 60000);

  it("the day's reconciliation counts them, with no PAYSTACK_ONLY or REFUND_NOT_RECORDED", async () => {
    const { sub } = await subscribeElevate(t);
    // The refund webhook missed (dev's 22 Nov run flagged two of these).
    fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    const today = new Date().toISOString().slice(0, 10);
    const result = await paymentReconciliationService.reconcileDay(today, { tenantIds: [t.tenantId] });
    expect(result.mismatches.map((m) => m.kind)).toEqual([]);
    expect(result).toMatchObject({ cardVerificationRefundCount: 1, refundCount: 1 });
  }, 60000);
});

describe('a genuine refund of the subscription', () => {
  it('still ends access at once, card update or not', async () => {
    const { reference, sub } = await subscribeElevate(t);
    const { refund } = fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    await sendWebhook('refund.processed', refund);
    expect((await tenantOf(t)).subscriptionTier).toBe('ELEVATE');

    await sendWebhook('refund.processed', { id: 'rf_genuine', transaction_reference: reference, amount: ELEVATE_M, currency: 'ZAR' });
    const tenant = await tenantOf(t);
    expect(tenant.subscriptionTier).toBe('SPARK');
    expect(fakePaystack.subscriptions.get(sub.subscription_code)?.status).toBe('cancelled');
    const issued = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { tenantId: t.tenantId, type: 'REFUND_ISSUED' } });
    expect(issued.payload).toMatchObject({ product: 'SUBSCRIPTION', effect: 'SUBSCRIPTION_ENDED' });
  }, 60000);

  it("a R1 refund of a payment of ours is that payment's refund, whatever its note says", async () => {
    const { reference } = await subscribeElevate(t);
    const sub = (await tenantOf(t)).paystackSubscriptionCode!;
    const note = `Refund for update card charge [Subscription: ${sub}]`;
    await sendWebhook('refund.processed', { id: 'rf_ours', transaction_reference: reference, amount: 100, currency: 'ZAR', merchant_note: note, customer_note: note });
    const issued = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { tenantId: t.tenantId, type: 'REFUND_ISSUED' } });
    expect(issued.payload).toMatchObject({ product: 'SUBSCRIPTION', full: false, effect: 'PARTIAL_RECORDED_ONLY' });
    expect((await ledgerOf(t)).some((e) => (e.payload as { reason?: string } | null)?.reason === 'CARD_VERIFICATION')).toBe(false);
  }, 60000);
});

describe('recognising them is strict', () => {
  const charge = {
    amount: 100,
    currency: 'ZAR',
    channel: 'card',
    reference: 'T361996336318561',
    metadata: { transaction_type: 'update_card', custom_fields: [{ variable_name: 'subscription_code', value: 'SUB_e7ahgyfo20stmd4' }] },
  };
  const note = 'Refund for update card charge [Subscription: SUB_e7ahgyfo20stmd4]';
  const refund = { amount: 100, currency: 'ZAR', merchant_note: note, customer_note: note, transaction_reference: 'T361996336318561', customer: {} };

  it('the charge needs the amount, the currency, the card channel, the update_card marker and a subscription', () => {
    expect(cardVerificationChargeOf(charge)).toEqual({ subscriptionCode: 'SUB_e7ahgyfo20stmd4', reference: 'T361996336318561' });
    expect(cardVerificationChargeOf({ ...charge, amount: 200 })).toBeNull();
    expect(cardVerificationChargeOf({ ...charge, currency: 'NGN' })).toBeNull();
    expect(cardVerificationChargeOf({ ...charge, channel: 'eft' })).toBeNull();
    expect(cardVerificationChargeOf({ ...charge, metadata: { ...charge.metadata, transaction_type: 'payment' } })).toBeNull();
    expect(cardVerificationChargeOf({ ...charge, metadata: { transaction_type: 'update_card' } })).toBeNull();
    // A R1 order of ours: our metadata, never Paystack's marker.
    expect(cardVerificationChargeOf({ ...charge, reference: 'ord_x', metadata: { orderId: 'o1', kind: 'TICKET_ORDER' } })).toBeNull();
  });

  it("the refund needs the amount, the currency and Paystack's note naming the subscription", () => {
    expect(cardVerificationRefundOf(refund)).toEqual({ subscriptionCode: 'SUB_e7ahgyfo20stmd4', transactionReference: 'T361996336318561' });
    expect(cardVerificationRefundOf({ ...refund, amount: 99_900 })).toBeNull();
    expect(cardVerificationRefundOf({ ...refund, merchant_note: 'Customer asked' })).toBeNull();
    expect(cardVerificationRefundOf({ ...refund, customer_note: 'Refund for update card charge [Subscription: SUB_other]' })).toBeNull();
    expect(cardVerificationRefundOf({ ...refund, merchant_note: `${note} extra` })).toBeNull();
  });

  it('a verification charge naming a subscription no tenant holds is not claimed: unhandled and alerted, as before', async () => {
    await subscribeElevate(t);
    clearSentEmails();
    const stranger = fakePaystack.addSubscription({ email: 'stranger@test.invalid', plan_code: 'PLN_x', plan_amount: 1 });
    const { charge: foreign } = fakePaystack.updateCard(stranger.subscription_code, NEW_CARD);
    await sendWebhook('charge.success', foreign);
    expect(await prisma.paymentLedgerEntry.count({ where: { type: 'WEBHOOK_EVENT_UNHANDLED', paystackReference: String(foreign['id']) } })).toBe(1);
    expect(paymentAlerts().some((e) => /nothing handled/.test(e.subject))).toBe(true);
  }, 60000);
});

// ─────────────────────────────────────────
//  NEVER CHARGE A REPLACED CARD (fix/payments-go-live, round 2)
//
//  A plan change (the only charge to a saved card) reads the subscription's
//  current authorisation from Paystack at that moment and charges it, never
//  the stored code; unconfirmed, it refuses before anything is claimed,
//  disabled or charged. The card refreshes store the code too.
// ─────────────────────────────────────────

const changeTier = (t: PaymentsTenant, tier: string, period: string) =>
  request(app).put('/api/subscriptions/change-tier').set(headersFor(t.admin)).send({ tier, period });
const createCalls = () => fakePaystack.calls.filter((c) => c.method === 'POST' && c.path === '/subscription');
const disableCalls = () => fakePaystack.calls.filter((c) => c.method === 'POST' && c.path === '/subscription/disable');
const isSubscriptionRead = (c: { method: string; path: string }) => c.method === 'GET' && /^\/subscription\/SUB_[^/]+$/.test(c.path);
const CARD_NOT_CONFIRMED_MESSAGE = "We couldn't confirm your card just now. Nothing was charged. Please try again in a few minutes.";

describe('a plan change charges the current card', () => {
  it('after a card update: the new authorisation, not the stored old one', async () => {
    const { sub } = await subscribeElevate(t);
    expect((await tenantOf(t)).paystackAuthorizationCode).toBe('AUTH_fake');
    // Replaced on Paystack's page; no webhook has refreshed anything yet.
    fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    const replacement = fakePaystack.subscriptions.get(sub.subscription_code)!.authorization_code;
    expect(replacement).not.toBe('AUTH_fake');

    const res = await changeTier(t, 'ELEVATE', 'ANNUAL');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ outcome: 'accepted' });
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0]!.body).toMatchObject({ authorization: replacement });
    // And the stored card is current now.
    expect(await tenantOf(t)).toMatchObject({ paystackAuthorizationCode: replacement, paystackCardLast4: '0409' });
  }, 60000);

  it('with no card update, exactly as before: the same card, accepted, the charge initiated and the change pending', async () => {
    const { sub } = await subscribeElevate(t);
    const before = await tenantOf(t);
    const res = await changeTier(t, 'ELEVATE', 'ANNUAL');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ outcome: 'accepted' });
    expect(disableCalls().map((c) => c.body?.['code'])).toEqual([sub.subscription_code]);
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0]!.body).toEqual({ customer: before.paystackCustomerCode, plan: expect.any(String), authorization: 'AUTH_fake' });
    const after = await tenantOf(t);
    expect(after).toMatchObject({
      paystackAuthorizationCode: 'AUTH_fake',
      paystackCardLast4: before.paystackCardLast4,
      paystackCardBrand: before.paystackCardBrand,
      subscriptionPendingTier: 'ELEVATE',
      subscriptionPendingPeriod: 'ANNUAL',
    });
    expect(after.subscriptionPendingReference).toMatch(/^upg_/);
    expect((await ledgerOf(t)).at(-1)).toMatchObject({ type: 'SUBSCRIPTION_CHARGE_INITIATED', amountCents: SUBSCRIPTION_PRICES_CENTS.ELEVATE.ANNUAL });
  }, 60000);

  const refusedWithNothingDone = async (status: number) => {
    const before = await ledgerOf(t);
    const res = await changeTier(t, 'ELEVATE', 'ANNUAL');
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code: 'PAYMENT_CARD_NOT_CONFIRMED', message: CARD_NOT_CONFIRMED_MESSAGE });
    // Nothing disabled, created, claimed or recorded.
    expect(disableCalls()).toEqual([]);
    expect(createCalls()).toEqual([]);
    expect(await tenantOf(t)).toMatchObject({ subscriptionTier: 'ELEVATE', subscriptionPeriod: 'MONTHLY', subscriptionPendingReference: null, subscriptionNeedsSync: false });
    expect((await ledgerOf(t)).length).toBe(before.length);
  };

  it("Paystack unreachable: refused with the message, and nothing charged or recorded", async () => {
    const { sub } = await subscribeElevate(t);
    // The read is a GET: the client retries it twice, so all three fail.
    fakePaystack.failNext(isSubscriptionRead, 'network', 3);
    await refusedWithNothingDone(503);
    expect(fakePaystack.calls.filter(isSubscriptionRead)).toHaveLength(3);
    expect(fakePaystack.subscriptions.get(sub.subscription_code)?.status).toBe('active');
  }, 60000);

  it('no reusable authorisation on the subscription: refused with the message, and nothing charged or recorded', async () => {
    const { sub } = await subscribeElevate(t);
    fakePaystack.subscriptions.get(sub.subscription_code)!.authorization_reusable = false;
    await refusedWithNothingDone(422);
  }, 60000);
});

describe('the card refreshes store the authorisation code too', () => {
  const replaced = async () => {
    const { sub } = await subscribeElevate(t);
    const { refund } = fakePaystack.updateCard(sub.subscription_code, NEW_CARD);
    return { sub, refund, code: fakePaystack.subscriptions.get(sub.subscription_code)!.authorization_code };
  };

  it('after the verification refund arrives', async () => {
    const { refund, code } = await replaced();
    await sendWebhook('refund.pending', { ...refund, status: 'pending' });
    expect((await tenantOf(t)).paystackAuthorizationCode).toBe(code);
  }, 60000);

  it('on POST /verify', async () => {
    const { code } = await replaced();
    expect((await verify(t)).status).toBe(200);
    expect((await tenantOf(t)).paystackAuthorizationCode).toBe(code);
  }, 60000);

  it('in the daily sync', async () => {
    const { code } = await replaced();
    await subscriptionSyncService.syncMany({ onlyFlagged: false, tenantIds: [t.tenantId] });
    expect((await tenantOf(t)).paystackAuthorizationCode).toBe(code);
  }, 60000);
});

describe("the card's brand", () => {
  it('"visa " is stored and returned as "Visa"', async () => {
    await subscribeElevate(t);
    // Paystack's subscription.create carried card_type "visa ".
    expect((await tenantOf(t)).paystackCardBrand).toBe('Visa');
    expect((await status(t)).body.data.card.brand).toBe('Visa');
  }, 60000);

  it('a row stored before the fix ("visa ") is returned as "Visa", and the sync leaves it alone', async () => {
    await subscribeElevate(t);
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { paystackCardBrand: 'visa ' } });
    expect((await status(t)).body.data.card.brand).toBe('Visa');
    expect(await subscriptionSyncService.syncMany({ onlyFlagged: false, tenantIds: [t.tenantId] })).toMatchObject({ corrected: 0 });
  }, 60000);

  it('trimmed, each word capitalised, empty as null', () => {
    expect(displayCardBrand('visa ')).toBe('Visa');
    expect(displayCardBrand(' MASTERCARD')).toBe('Mastercard');
    expect(displayCardBrand('american  express')).toBe('American Express');
    expect(displayCardBrand('Visa')).toBe('Visa');
    expect(displayCardBrand('   ')).toBeNull();
    expect(displayCardBrand(null)).toBeNull();
  });
});
