import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { prisma, createTestEventDay } from '../helpers/fixtures.js';
import { fakePaystack } from '../helpers/fake-paystack.js';
import { sendWebhook } from '../helpers/paystack-webhook.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { paymentMaintenanceService } from '../../src/modules/payment-reconciliation/payment-maintenance.service.js';
import { EVENT_PASS_PRICES_CENTS, SMS_BUNDLE_UNIT_PRICE_CENTS } from '../../src/modules/event-pass/event-pass-plans.config.js';
import { SUBSCRIPTION_PRICES_CENTS } from '../../src/modules/subscription/subscription-plans.config.js';
import { PENDING_CHECKOUT_REUSE_MS } from '../../src/shared/payments/pending-checkout.util.js';
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
//  FOLLOW-UPS TO PAYMENTS RELEASE 1, end to end against the fake Paystack:
//   1. billing history entries carry a kind and a product;
//   2. a pass or bundle reconcile records a failed or abandoned payment;
//   3. GET /api/subscriptions and verify report the latest subscription
//      payment's outcome, refunded, reversed and under review included;
//   4. 409 PAYMENT_ALREADY_PENDING carries the pending purchase;
//   5. the event's purchase list, whatever the pass and the `sms` flag.
// ─────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const CELEBRATE_M = SUBSCRIPTION_PRICES_CENTS.CELEBRATE.MONTHLY;
const referenceOf = (url: string) => url.split('/').pop() as string;

const buyPass = (t: PaymentsTenant, passTier: string) =>
  request(app).post(`/api/events/${t.eventId}/pass/purchase`).set(headersFor(t.admin)).send({ passTier });
const buyBundle = (t: PaymentsTenant, smsCount: number) =>
  request(app).post(`/api/events/${t.eventId}/pass/sms-bundle/purchase`).set(headersFor(t.admin)).send({ smsCount });
const payPass = async (t: PaymentsTenant, passTier: string) => {
  const res = await buyPass(t, passTier);
  const reference = referenceOf(res.body.data.authorizationUrl);
  const data = fakePaystack.pay(reference);
  await sendWebhook('charge.success', data);
  return { reference, data, purchaseId: res.body.data.purchaseId as string };
};
const payBundle = async (t: PaymentsTenant, smsCount: number) => {
  const res = await buyBundle(t, smsCount);
  const reference = referenceOf(res.body.data.authorizationUrl);
  const data = fakePaystack.pay(reference);
  await sendWebhook('charge.success', data);
  return { reference, data };
};
const subscribe = (t: PaymentsTenant, tier = 'CELEBRATE', period = 'MONTHLY') =>
  request(app).post('/api/subscriptions/subscribe').set(headersFor(t.admin)).send({ tier, period });
const status = (t: PaymentsTenant) => request(app).get('/api/subscriptions').set(headersFor(t.admin));
const history = async (t: PaymentsTenant) =>
  (await request(app).get('/api/billing-history').set(headersFor(t.admin))).body.data as {
    kind: string;
    product: string | null;
    outcome: string;
    description: string;
  }[];

// Subscribe and pay: charge.success then subscription.create.
const subscribeAndActivate = async (t: PaymentsTenant) => {
  const res = await subscribe(t);
  const reference = referenceOf(res.body.data.authorizationUrl);
  trackedReferences.push(reference);
  const charge = fakePaystack.pay(reference);
  await sendWebhook('charge.success', charge);
  await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(fakePaystack.subscriptionFor(t.email).at(-1)!));
  return { reference, charge };
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

describe('1. billing history: kind and product', () => {
  it('a subscription charge and its refund carry their kind and product', async () => {
    const { reference } = await subscribeAndActivate(t);
    await sendWebhook('refund.processed', { id: 'rf_hist_sub', transaction_reference: reference, amount: CELEBRATE_M, currency: 'ZAR' });

    const rows = await history(t);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'CHARGE', product: 'SUBSCRIPTION', outcome: 'SUCCESS' }),
        expect.objectContaining({ kind: 'REFUND', product: 'SUBSCRIPTION' }),
      ])
    );
    for (const row of rows) expect(row.kind).not.toBe('OTHER');
  }, 60000);

  it('a refunded pass and a refunded bundle are REFUND with their own product; a lost chargeback is REVERSAL', async () => {
    const pass = await payPass(t, 'STANDARD');
    const bundle = await payBundle(t, 10);
    await sendWebhook('refund.processed', { id: 'rf_hist_sms', transaction_reference: bundle.reference, amount: 10 * SMS_BUNDLE_UNIT_PRICE_CENTS, currency: 'ZAR' });
    await sendWebhook('charge.dispute.resolve', {
      id: 'dsp_hist', refund_amount: EVENT_PASS_PRICES_CENTS.STANDARD, currency: 'ZAR', resolution: 'merchant-accepted',
      transaction: { id: pass.data['id'], reference: pass.reference },
    });

    const rows = await history(t);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'REFUND', product: 'SMS_BUNDLE', description: 'Refund: SMS bundle' }),
        expect.objectContaining({ kind: 'REVERSAL', product: 'EVENT_PASS', description: 'Payment reversed: Event Pass' }),
      ])
    );
  }, 60000);

  it('cancelling is CANCELLATION', async () => {
    await subscribeAndActivate(t);
    await request(app).post('/api/subscriptions/cancel').set(headersFor(t.admin));
    expect(await history(t)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'CANCELLATION', product: 'SUBSCRIPTION' })]));
  }, 60000);
});

describe('2. reconcile records a failed or abandoned payment', () => {
  const reconcilePass = (purchaseId: string) =>
    request(app).post(`/api/events/${t.eventId}/pass/purchases/${purchaseId}/reconcile`).set(headersFor(t.admin));

  it('abandoned: FAILED, recorded as the webhook would; paid later on the same checkout, still granted', async () => {
    const res = await buyPass(t, 'SMALL');
    const reference = referenceOf(res.body.data.authorizationUrl);
    const reconciled = await reconcilePass(res.body.data.purchaseId);
    expect(reconciled.body.data.status).toBe('FAILED');
    const failed = await prisma.paymentLedgerEntry.findMany({ where: { paystackReference: reference, type: 'EVENT_PASS_PURCHASE_FAILED' } });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.relatedId).toBe(res.body.data.purchaseId);

    // Asking again records nothing more.
    expect((await reconcilePass(res.body.data.purchaseId)).body.data.status).toBe('FAILED');
    expect(await prisma.paymentLedgerEntry.count({ where: { paystackReference: reference, type: 'EVENT_PASS_PURCHASE_FAILED' } })).toBe(1);

    await sendWebhook('charge.success', fakePaystack.pay(reference));
    expect((await prisma.eventPassPurchase.findFirstOrThrow({ where: { paymentRef: reference } })).status).toBe('PAID');
  }, 60000);

  it('failed: FAILED', async () => {
    const res = await buyPass(t, 'SMALL');
    fakePaystack.fail(referenceOf(res.body.data.authorizationUrl));
    expect((await reconcilePass(res.body.data.purchaseId)).body.data.status).toBe('FAILED');
  }, 60000);

  it('still in progress (an EFT clearing): left PENDING, nothing recorded', async () => {
    const res = await buyPass(t, 'SMALL');
    const reference = referenceOf(res.body.data.authorizationUrl);
    fakePaystack.transactions.get(reference)!.status = 'ongoing';
    expect((await reconcilePass(res.body.data.purchaseId)).body.data.status).toBe('PENDING');
    expect(await prisma.paymentLedgerEntry.count({ where: { paystackReference: reference, type: 'EVENT_PASS_PURCHASE_FAILED' } })).toBe(0);
  }, 60000);

  it('an SMS bundle the same way', async () => {
    await payPass(t, 'STANDARD');
    const res = await buyBundle(t, 10);
    const reference = referenceOf(res.body.data.authorizationUrl);
    const reconciled = await request(app)
      .post(`/api/events/${t.eventId}/pass/sms-bundle/purchases/${res.body.data.purchaseId}/reconcile`)
      .set(headersFor(t.admin));
    expect(reconciled.body.data.status).toBe('FAILED');
    expect(await prisma.paymentLedgerEntry.count({ where: { paystackReference: reference, type: 'SMS_BUNDLE_PURCHASE_FAILED' } })).toBe(1);
  }, 60000);
});

describe('3. the latest subscription payment', () => {
  it('none yet: null; started: PENDING; paid: PAID; refunded: REFUNDED, from GET and from verify', async () => {
    expect((await status(t)).body.data.latestPayment).toBeNull();

    const res = await subscribe(t);
    const reference = referenceOf(res.body.data.authorizationUrl);
    trackedReferences.push(reference);
    expect((await status(t)).body.data.latestPayment).toMatchObject({ status: 'PENDING', amountCents: CELEBRATE_M, currency: 'ZAR' });

    const charge = fakePaystack.pay(reference);
    await sendWebhook('charge.success', charge);
    await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(fakePaystack.subscriptionFor(t.email).at(-1)!));
    expect((await status(t)).body.data.latestPayment).toMatchObject({ status: 'PAID', occurredAt: charge['paid_at'], takenBackAt: null });

    await sendWebhook('refund.processed', { id: 'rf_latest', transaction_reference: reference, amount: CELEBRATE_M, currency: 'ZAR' });
    const verified = await request(app).post('/api/subscriptions/verify').set(headersFor(t.admin));
    expect(verified.body.data).toMatchObject({ tier: 'SPARK', latestPayment: { status: 'REFUNDED' } });
    expect(verified.body.data.latestPayment.takenBackAt).not.toBeNull();
  }, 60000);

  it('a lost chargeback: REVERSED; a partial refund leaves it PAID', async () => {
    const { reference, charge } = await subscribeAndActivate(t);
    await sendWebhook('refund.processed', { id: 'rf_latest_part', transaction_reference: reference, amount: 100, currency: 'ZAR' });
    expect((await status(t)).body.data.latestPayment.status).toBe('PAID');
    await sendWebhook('charge.dispute.resolve', {
      id: 'dsp_latest', refund_amount: CELEBRATE_M, currency: 'ZAR', resolution: 'merchant-accepted', transaction: { id: charge['id'], reference },
    });
    expect((await status(t)).body.data.latestPayment.status).toBe('REVERSED');
  }, 60000);

  it('the wrong amount: UNDER_REVIEW', async () => {
    const res = await subscribe(t);
    const reference = referenceOf(res.body.data.authorizationUrl);
    trackedReferences.push(reference);
    await sendWebhook('charge.success', fakePaystack.pay(reference, { amount: 100 }));
    expect((await status(t)).body.data.latestPayment.status).toBe('UNDER_REVIEW');
  }, 60000);

  it('left unpaid and cleared by the stale sweep: FAILED', async () => {
    const res = await subscribe(t);
    trackedReferences.push(referenceOf(res.body.data.authorizationUrl));
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionPendingStartedAt: new Date(Date.now() - 2 * DAY) } });
    await paymentMaintenanceService.sweepStalePending({ tenantIds: [t.tenantId] });
    expect((await status(t)).body.data.latestPayment.status).toBe('FAILED');
  }, 60000);

  it('a renewal that failed: FAILED', async () => {
    await subscribeAndActivate(t);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    await sendWebhook('invoice.payment_failed', {
      id: Date.now(), invoice_code: `INV_${Date.now()}`, amount: CELEBRATE_M, currency: 'ZAR', status: 'failed',
      subscription: { subscription_code: tenant.paystackSubscriptionCode }, customer: { customer_code: tenant.paystackCustomerCode, email: t.email },
    });
    expect((await status(t)).body.data.latestPayment.status).toBe('FAILED');
  }, 60000);
});

describe('4. 409 PAYMENT_ALREADY_PENDING carries the pending purchase', () => {
  it('a pass: what, when, when another can start, and its checkout link', async () => {
    const first = await buyPass(t, 'SMALL');
    const other = await buyPass(t, 'LARGE');
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('PAYMENT_ALREADY_PENDING');
    const pending = other.body.details.pending;
    expect(pending).toMatchObject({
      product: 'EVENT_PASS',
      purchaseId: first.body.data.purchaseId,
      passTier: 'SMALL',
      smsCount: null,
      plan: null,
      isPlanChange: false,
      amountCents: EVENT_PASS_PRICES_CENTS.SMALL,
      authorizationUrl: first.body.data.authorizationUrl,
    });
    expect(new Date(pending.canStartAnotherAt).getTime() - new Date(pending.startedAt).getTime()).toBe(PENDING_CHECKOUT_REUSE_MS);
  }, 60000);

  it('a bundle', async () => {
    await payPass(t, 'STANDARD');
    const first = await buyBundle(t, 50);
    const other = await buyBundle(t, 60);
    expect(other.status).toBe(409);
    expect(other.body.details.pending).toMatchObject({
      product: 'SMS_BUNDLE',
      purchaseId: first.body.data.purchaseId,
      smsCount: 50,
      passTier: null,
      amountCents: 50 * SMS_BUNDLE_UNIT_PRICE_CENTS,
      authorizationUrl: first.body.data.authorizationUrl,
    });
  }, 60000);

  it('a subscription checkout', async () => {
    const first = await subscribe(t, 'CELEBRATE', 'MONTHLY');
    trackedReferences.push(referenceOf(first.body.data.authorizationUrl));
    const other = await subscribe(t, 'ELEVATE', 'ANNUAL');
    expect(other.status).toBe(409);
    const pending = other.body.details.pending;
    expect(pending).toMatchObject({
      product: 'SUBSCRIPTION',
      purchaseId: null,
      plan: { tier: 'CELEBRATE', period: 'MONTHLY' },
      isPlanChange: false,
      amountCents: CELEBRATE_M,
      authorizationUrl: first.body.data.authorizationUrl,
    });
    expect(pending.startedAt).not.toBeNull();
    expect(pending.canStartAnotherAt).not.toBeNull();
  }, 60000);

  it('a plan change being confirmed: no checkout link', async () => {
    await subscribeAndActivate(t);
    const marker = 'upg_followups_test';
    await prisma.tenant.update({
      where: { id: t.tenantId },
      data: { subscriptionPendingReference: marker, subscriptionPendingTier: 'ELEVATE', subscriptionPendingPeriod: 'MONTHLY', subscriptionPendingStartedAt: new Date() },
    });
    const res = await request(app).put('/api/subscriptions/change-tier').set(headersFor(t.admin)).send({ tier: 'ELEVATE', period: 'ANNUAL' });
    expect(res.status).toBe(409);
    expect(res.body.details.pending).toMatchObject({
      product: 'SUBSCRIPTION',
      plan: { tier: 'ELEVATE', period: 'MONTHLY' },
      isPlanChange: true,
      authorizationUrl: null,
    });
  }, 60000);
});

describe("5. the event's purchase list", () => {
  const purchases = (actor = t.admin) => request(app).get(`/api/events/${t.eventId}/pass/purchases`).set(headersFor(actor));

  it('no pass at all: 200 with empty lists', async () => {
    const res = await purchases();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ passPurchases: [], smsBundlePurchases: [] });
  }, 60000);

  it('a refunded pass: its purchases and its bundles are still listed, with their statuses, even with sms switched off', async () => {
    const pass = await payPass(t, 'STANDARD');
    const bundle = await payBundle(t, 10);
    await sendWebhook('refund.processed', { id: 'rf_list', transaction_reference: pass.reference, amount: EVENT_PASS_PRICES_CENTS.STANDARD, currency: 'ZAR' });
    expect(await prisma.eventPass.findUnique({ where: { eventId: t.eventId } })).toBeNull();

    vi.stubEnv('FEATURES_DISABLED', 'sms');
    const res = await purchases();
    expect(res.status).toBe(200);
    expect(res.body.data.passPurchases).toEqual([
      expect.objectContaining({ id: pass.purchaseId, passTier: 'STANDARD', status: 'REFUNDED', amountPaidCents: EVENT_PASS_PRICES_CENTS.STANDARD, currency: 'ZAR' }),
    ]);
    expect(res.body.data.smsBundlePurchases).toEqual([expect.objectContaining({ smsCount: 10, status: 'PAID' })]);
    expect(bundle.reference).toBeTruthy();
  }, 60000);

  it("another tenant can't read it", async () => {
    await payPass(t, 'SMALL');
    const other = await createPaymentsTenant();
    expect((await purchases(other.admin)).status).toBe(404);
  }, 60000);
});

describe('6. a double payment grants nothing extra', () => {
  const doubleAlerts = () => paymentAlerts().filter((e) => /paid for twice/.test(e.subject));
  const reconcilePass = (purchaseId: string) =>
    request(app).post(`/api/events/${t.eventId}/pass/purchases/${purchaseId}/reconcile`).set(headersFor(t.admin));

  it('a pass: an abandoned checkout paid after a new one was paid ends UNDER_REVIEW and alerts once', async () => {
    // Checkout A is abandoned (the reconcile marks it FAILED), so B starts.
    const a = await buyPass(t, 'SMALL');
    const refA = referenceOf(a.body.data.authorizationUrl);
    expect((await reconcilePass(a.body.data.purchaseId)).body.data.status).toBe('FAILED');
    const b = await payPass(t, 'SMALL');
    expect(b.purchaseId).not.toBe(a.body.data.purchaseId);

    // A is paid after all, and its webhook delivered three times.
    const dataA = fakePaystack.pay(refA);
    await sendWebhook('charge.success', dataA);
    await sendWebhook('charge.success', dataA);
    await sendWebhook('charge.success', { ...dataA, redelivered: true });

    expect((await prisma.eventPassPurchase.findFirstOrThrow({ where: { paymentRef: refA } })).status).toBe('UNDER_REVIEW');
    expect((await prisma.eventPassPurchase.findFirstOrThrow({ where: { paymentRef: b.reference } })).status).toBe('PAID');
    expect((await prisma.eventPass.findUniqueOrThrow({ where: { eventId: t.eventId } })).passTier).toBe('SMALL');
    const rows = await prisma.paymentLedgerEntry.findMany({ where: { paystackReference: refA, type: { in: ['PAYMENT_DUPLICATE', 'EVENT_PASS_PURCHASE_SUCCEEDED'] } } });
    expect(rows.map((r) => r.type)).toEqual(['PAYMENT_DUPLICATE']);
    expect(rows[0]!.payload).toMatchObject({ product: 'EVENT_PASS', duplicates: { reference: b.reference } });
    expect(await prisma.paymentMismatch.count({ where: { paystackReference: refA, kind: 'DUPLICATE_PAYMENT' } })).toBe(1);
    expect(doubleAlerts()).toHaveLength(1);

    // Refunding it takes nothing away: the event keeps B's pass.
    await sendWebhook('refund.processed', { id: 'rf_dup_pass', transaction_reference: refA, amount: EVENT_PASS_PRICES_CENTS.SMALL, currency: 'ZAR' });
    expect((await prisma.eventPassPurchase.findFirstOrThrow({ where: { paymentRef: refA } })).status).toBe('REFUNDED');
    expect((await prisma.eventPass.findUniqueOrThrow({ where: { eventId: t.eventId } })).passTier).toBe('SMALL');
  }, 60000);

  it('a pass bought again after the last one expired is a new purchase, not a duplicate', async () => {
    // A day 90 days ago: the pass expired 30 days after it.
    const day = await createTestEventDay(t.eventId, t.admin.id);
    await prisma.eventDay.update({ where: { id: day.id }, data: { date: new Date(Date.now() - 90 * DAY) } });
    await payPass(t, 'SMALL');
    const again = await payPass(t, 'SMALL');
    try {
      expect((await prisma.eventPassPurchase.findFirstOrThrow({ where: { paymentRef: again.reference } })).status).toBe('PAID');
      expect(doubleAlerts()).toHaveLength(0);
    } finally {
      // The shared cleanup deletes the event, which its day would block.
      await prisma.eventDay.delete({ where: { id: day.id } });
    }
  }, 60000);

  it('a bundle, confirmed by the reconcile: UNDER_REVIEW, no extra credits, one alert', async () => {
    await payPass(t, 'STANDARD');
    const reconcileBundle = (purchaseId: string) =>
      request(app).post(`/api/events/${t.eventId}/pass/sms-bundle/purchases/${purchaseId}/reconcile`).set(headersFor(t.admin));
    const a = await buyBundle(t, 10);
    const refA = referenceOf(a.body.data.authorizationUrl);
    expect((await reconcileBundle(a.body.data.purchaseId)).body.data.status).toBe('FAILED');
    await payBundle(t, 10);

    fakePaystack.pay(refA);
    expect((await reconcileBundle(a.body.data.purchaseId)).body.data.status).toBe('UNDER_REVIEW');
    expect((await reconcileBundle(a.body.data.purchaseId)).body.data.status).toBe('UNDER_REVIEW');
    const balance = (await request(app).get(`/api/events/${t.eventId}/pass/sms-bundle`).set(headersFor(t.admin))).body.data;
    expect(balance.purchasedTotal).toBe(10);
    expect(await prisma.paymentLedgerEntry.count({ where: { paystackReference: refA, type: 'PAYMENT_DUPLICATE' } })).toBe(1);
    expect(doubleAlerts()).toHaveLength(1);
  }, 60000);

  it('two deliberate bundles of the same count, minutes apart: both PAID, both credited, no alert', async () => {
    await payPass(t, 'STANDARD');
    const first = await payBundle(t, 10);
    const second = await payBundle(t, 10);
    expect(second.reference).not.toBe(first.reference);
    for (const ref of [first.reference, second.reference]) {
      expect((await prisma.eventSmsBundlePurchase.findFirstOrThrow({ where: { paymentRef: ref } })).status).toBe('PAID');
    }
    const balance = (await request(app).get(`/api/events/${t.eventId}/pass/sms-bundle`).set(headersFor(t.admin))).body.data;
    expect(balance.purchasedTotal).toBe(20);
    expect(await prisma.paymentLedgerEntry.count({ where: { eventId: t.eventId, type: 'PAYMENT_DUPLICATE' } })).toBe(0);
    expect(doubleAlerts()).toHaveLength(0);
  }, 60000);

  it('an older checkout still PENDING (an EFT clearing), paid after a newer one of the same count: both granted', async () => {
    await payPass(t, 'STANDARD');
    const older = await buyBundle(t, 10);
    const refOlder = referenceOf(older.body.data.authorizationUrl);
    // Past the reuse window, so a second checkout can start; the first is
    // never marked FAILED.
    await prisma.eventSmsBundlePurchase.update({ where: { id: older.body.data.purchaseId }, data: { purchasedAt: new Date(Date.now() - PENDING_CHECKOUT_REUSE_MS - 60_000) } });
    await payBundle(t, 10);
    await sendWebhook('charge.success', fakePaystack.pay(refOlder));
    expect((await prisma.eventSmsBundlePurchase.findFirstOrThrow({ where: { paymentRef: refOlder } })).status).toBe('PAID');
    const balance = (await request(app).get(`/api/events/${t.eventId}/pass/sms-bundle`).set(headersFor(t.admin))).body.data;
    expect(balance.purchasedTotal).toBe(20);
    expect(doubleAlerts()).toHaveLength(0);
  }, 60000);

  it('a subscription: a stale checkout paid after a newer one is recorded, nothing changes, and its refund takes nothing back', async () => {
    const a = await subscribe(t);
    const refA = referenceOf(a.body.data.authorizationUrl);
    trackedReferences.push(refA);
    // Past the reuse window, a new checkout B starts and is paid.
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionPendingStartedAt: new Date(Date.now() - PENDING_CHECKOUT_REUSE_MS - 60_000) } });
    const { reference: refB } = await subscribeAndActivate(t);
    expect(refB).not.toBe(refA);
    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(before).toMatchObject({ subscriptionTier: 'CELEBRATE', subscriptionPendingReference: null });

    const dataA = fakePaystack.pay(refA);
    await sendWebhook('charge.success', dataA);
    await sendWebhook('charge.success', { ...dataA, redelivered: true });

    const after = await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(after.subscriptionCurrentPeriodEnd).toEqual(before.subscriptionCurrentPeriodEnd);
    expect(after.subscriptionNeedsSync).toBe(before.subscriptionNeedsSync);
    expect(await prisma.paymentLedgerEntry.count({ where: { tenantId: t.tenantId, type: 'SUBSCRIPTION_CHARGE_SUCCEEDED' } })).toBe(1);
    expect(await prisma.paymentLedgerEntry.count({ where: { paystackReference: refA, type: 'PAYMENT_DUPLICATE' } })).toBe(1);
    expect(doubleAlerts()).toHaveLength(1);
    expect((await status(t)).body.data.latestPayment.status).toBe('UNDER_REVIEW');

    clearSentEmails();
    await sendWebhook('refund.processed', { id: 'rf_dup_sub', transaction_reference: refA, amount: CELEBRATE_M, currency: 'ZAR' });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionTier).toBe('CELEBRATE');
    const refund = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { paystackReference: refA, type: 'REFUND_ISSUED' } });
    expect(refund.payload).toMatchObject({ product: 'SUBSCRIPTION', effect: 'NOTHING_WAS_GRANTED' });
    expect((await status(t)).body.data.latestPayment.status).toBe('REFUNDED');
  }, 60000);
});

describe('7. billing history lists Event Pass and SMS bundle payments', () => {
  it('each payment and its refund, with the event, newest first', async () => {
    const event = await prisma.event.findUniqueOrThrow({ where: { id: t.eventId } });
    await payPass(t, 'STANDARD');
    const bundle = await payBundle(t, 10);
    await sendWebhook('refund.processed', { id: 'rf_hist_b', transaction_reference: bundle.reference, amount: 10 * SMS_BUNDLE_UNIT_PRICE_CENTS, currency: 'ZAR' });

    const rows = (await request(app).get('/api/billing-history').set(headersFor(t.admin))).body.data as {
      kind: string; product: string; outcome: string; occurredAt: string; event: { id: string; name: string } | null;
    }[];
    const eventRef = { id: t.eventId, name: event.name };
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'CHARGE', product: 'EVENT_PASS', outcome: 'SUCCESS', event: eventRef }),
        expect.objectContaining({ kind: 'CHARGE', product: 'SMS_BUNDLE', outcome: 'SUCCESS', event: eventRef }),
        expect.objectContaining({ kind: 'REFUND', product: 'SMS_BUNDLE', event: eventRef }),
      ])
    );
    const times = rows.map((r) => new Date(r.occurredAt).getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  }, 60000);

  it('a failed pass payment is a failed CHARGE; the subscription has no event', async () => {
    const res = await buyPass(t, 'SMALL');
    await request(app).post(`/api/events/${t.eventId}/pass/purchases/${res.body.data.purchaseId}/reconcile`).set(headersFor(t.admin));
    await subscribeAndActivate(t);
    const rows = (await request(app).get('/api/billing-history').set(headersFor(t.admin))).body.data;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'CHARGE', product: 'EVENT_PASS', outcome: 'FAILED' }),
        expect.objectContaining({ kind: 'CHARGE', product: 'SUBSCRIPTION', outcome: 'SUCCESS', event: null }),
      ])
    );
  }, 60000);
});
