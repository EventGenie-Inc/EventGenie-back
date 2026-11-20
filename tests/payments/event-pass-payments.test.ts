import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { prisma } from '../helpers/fixtures.js';
import { fakePaystack } from '../helpers/fake-paystack.js';
import { sendWebhook } from '../helpers/paystack-webhook.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { paymentMaintenanceService } from '../../src/modules/payment-reconciliation/payment-maintenance.service.js';
import { EVENT_PASS_PRICES_CENTS } from '../../src/modules/event-pass/event-pass-plans.config.js';
import { eventPassRepository } from '../../src/modules/event-pass/event-pass.repository.js';
import { PAYMENT_VERIFIES_PER_USER_PER_5_MIN } from '../../src/shared/middleware/rate-limit.middleware.js';
import {
  createPaymentsTenant,
  cleanupPayments,
  headersFor,
  installAuth,
  paymentAlerts,
  type PaymentsTenant,
} from './payments-fixtures.js';

// ─────────────────────────────────────────
//  EVENT PASS PAYMENTS (payments release 1), end to end: the real routes,
//  the fake Paystack, and webhooks signed as Paystack signs them. Covers the
//  readiness checklist's section 12 for passes: success, failure, abandoned
//  (the stale sweep), duplicate requests and deliveries, a bad signature, a
//  wrong amount and currency, a delayed webhook, the browser closed after
//  paying, concurrent requests, a Paystack timeout, unauthorised access,
//  and refunds and chargebacks.
// ─────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

const buy = (t: PaymentsTenant, passTier: unknown) =>
  request(app).post(`/api/events/${t.eventId}/pass/purchase`).set(headersFor(t.admin)).send({ passTier });

const referenceOf = (authorizationUrl: string): string => authorizationUrl.split('/').pop() as string;

const passOf = (eventId: string) => prisma.eventPass.findUnique({ where: { eventId } });
const purchaseOf = (paymentRef: string) => prisma.eventPassPurchase.findFirstOrThrow({ where: { paymentRef } });
const ledgerFor = (paymentRef: string) =>
  prisma.paymentLedgerEntry.findMany({ where: { paystackReference: paymentRef }, orderBy: { createdAt: 'asc' } });

// Buys a pass and completes payment through the webhook.
const buyAndPay = async (t: PaymentsTenant, passTier: 'SMALL' | 'STANDARD' | 'LARGE') => {
  const res = await buy(t, passTier);
  expect(res.status).toBe(200);
  const reference = referenceOf(res.body.data.authorizationUrl);
  const data = fakePaystack.pay(reference);
  const hook = await sendWebhook('charge.success', data);
  expect(hook.status).toBe(200);
  return { reference, data };
};

let t: PaymentsTenant;

beforeAll(async () => {}, 60000);

beforeEach(async () => {
  installAuth();
  clearSentEmails();
  t = await createPaymentsTenant();
}, 60000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPayments();
}, 120000);

afterAll(async () => {}, 60000);

describe('buying an Event Pass', () => {
  it("the signed charge.success grants it, with Paystack's transaction id and paid_at on the ledger", async () => {
    const res = await buy(t, 'STANDARD');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reused: false });
    expect(typeof res.body.data.purchaseId).toBe('string');
    const reference = referenceOf(res.body.data.authorizationUrl);

    // Nothing granted on the redirect alone.
    expect(await passOf(t.eventId)).toBeNull();

    const paidAt = '2026-11-18T08:30:00.000Z';
    const data = fakePaystack.pay(reference, { paidAt });
    const hook = await sendWebhook('charge.success', data);
    expect(hook.body.outcome).toBe('processed');

    expect((await passOf(t.eventId))?.passTier).toBe('STANDARD');
    const purchase = await purchaseOf(reference);
    expect(purchase.status).toBe('PAID');
    expect(purchase.paystackTransactionId).toBe(String(data['id']));

    const ledger = await ledgerFor(reference);
    expect(ledger.map((e) => e.type)).toEqual(['EVENT_PASS_PURCHASE_INITIATED', 'EVENT_PASS_PURCHASE_SUCCEEDED']);
    expect(ledger.every((e) => e.relatedId === purchase.id)).toBe(true);
    expect(ledger[1]!.occurredAt.toISOString()).toBe(paidAt);
    expect(ledger[1]!.paystackTransactionId).toBe(String(data['id']));
  }, 60000);

  it('a success for the wrong amount grants nothing: UNDER_REVIEW, a mismatch, an alert', async () => {
    const reference = referenceOf((await buy(t, 'LARGE')).body.data.authorizationUrl);
    const data = fakePaystack.pay(reference, { amount: 100 });
    await sendWebhook('charge.success', data);

    expect(await passOf(t.eventId)).toBeNull();
    expect((await purchaseOf(reference)).status).toBe('UNDER_REVIEW');
    expect((await ledgerFor(reference)).map((e) => e.type)).toContain('PAYMENT_AMOUNT_MISMATCH');
    const mismatch = await prisma.paymentMismatch.findFirstOrThrow({ where: { paystackReference: reference } });
    expect(mismatch).toMatchObject({ source: 'WEBHOOK', kind: 'UNEXPECTED_AMOUNT', expectedAmountCents: EVENT_PASS_PRICES_CENTS.LARGE, actualAmountCents: 100 });
    expect(paymentAlerts().some((e) => /wrong amount/.test(e.subject))).toBe(true);
  }, 60000);

  it('a success in the wrong currency grants nothing', async () => {
    const reference = referenceOf((await buy(t, 'SMALL')).body.data.authorizationUrl);
    await sendWebhook('charge.success', fakePaystack.pay(reference, { currency: 'NGN' }));
    expect(await passOf(t.eventId)).toBeNull();
    expect((await purchaseOf(reference)).status).toBe('UNDER_REVIEW');
  }, 60000);

  it('a failed attempt then a success on the same checkout is granted (FAILED → PAID)', async () => {
    const reference = referenceOf((await buy(t, 'SMALL')).body.data.authorizationUrl);
    await sendWebhook('charge.failed', fakePaystack.fail(reference));
    expect((await purchaseOf(reference)).status).toBe('FAILED');

    await sendWebhook('charge.success', fakePaystack.pay(reference));
    expect((await purchaseOf(reference)).status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('SMALL');
    const succeeded = (await ledgerFor(reference)).filter((e) => e.type === 'EVENT_PASS_PURCHASE_SUCCEEDED');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.payload).toMatchObject({ confirmedAfterFailure: true });
  }, 60000);

  it('a charge.failed after the purchase is paid never downgrades it', async () => {
    const { reference } = await buyAndPay(t, 'SMALL');
    await sendWebhook('charge.failed', { ...fakePaystack.webhookDataFor(reference), status: 'failed', id: 999_001 });
    expect((await purchaseOf(reference)).status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('SMALL');
  }, 60000);

  it('the same delivery twice is a duplicate: one success, one pass', async () => {
    const reference = referenceOf((await buy(t, 'SMALL')).body.data.authorizationUrl);
    const data = fakePaystack.pay(reference);
    expect((await sendWebhook('charge.success', data)).body.outcome).toBe('processed');
    expect((await sendWebhook('charge.success', data)).body.outcome).toBe('duplicate');
    const types = (await ledgerFor(reference)).map((e) => e.type);
    expect(types.filter((x) => x === 'EVENT_PASS_PURCHASE_SUCCEEDED')).toHaveLength(1);
  }, 60000);

  it('an invalid signature is 401 and changes nothing', async () => {
    const reference = referenceOf((await buy(t, 'SMALL')).body.data.authorizationUrl);
    const res = await sendWebhook('charge.success', fakePaystack.pay(reference), { signature: 'f'.repeat(128) });
    expect(res.status).toBe(401);
    expect((await purchaseOf(reference)).status).toBe('PENDING');
    expect(await passOf(t.eventId)).toBeNull();
  }, 60000);

  it('an unknown passTier is 422 EVENT_PASS_TIER_UNKNOWN with nothing saved', async () => {
    for (const bad of ['HUGE', undefined, 3]) {
      const res = await buy(t, bad);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('EVENT_PASS_TIER_UNKNOWN');
    }
    expect(await prisma.eventPassPurchase.count({ where: { eventId: t.eventId } })).toBe(0);
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(0);
  }, 60000);
});

describe('one pending checkout per event', () => {
  it('the same tier again reuses the checkout; another tier is 409 PAYMENT_ALREADY_PENDING', async () => {
    const first = await buy(t, 'STANDARD');
    const again = await buy(t, 'STANDARD');
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ authorizationUrl: first.body.data.authorizationUrl, purchaseId: first.body.data.purchaseId, reused: true });
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(1);

    const other = await buy(t, 'LARGE');
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('PAYMENT_ALREADY_PENDING');
    expect(other.body.message).toMatch(/Standard pass/);
  }, 60000);

  it('two purchases at the same moment start one checkout', async () => {
    // Forces the race: each request pauses after asking "is anything
    // pending?", so without the per-event lock both would see nothing and
    // both insert. With it, the second waits for the first to commit.
    const original = eventPassRepository.findRecentPendingPurchase;
    const slowed = async (...args: Parameters<typeof original>) => {
      const found = await original(...args);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return found;
    };
    vi.spyOn(eventPassRepository, 'findRecentPendingPurchase').mockImplementation(slowed as unknown as typeof original);
    const [a, b] = await Promise.all([buy(t, 'SMALL'), buy(t, 'SMALL')]);
    vi.restoreAllMocks();
    const statuses = [a.status, b.status].sort();
    // One starts it; the other reuses it, or is told it's still being set up.
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    expect(await prisma.eventPassPurchase.count({ where: { eventId: t.eventId } })).toBe(1);
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(1);
  }, 60000);

  it('after the reuse window a new checkout may start', async () => {
    const first = await buy(t, 'SMALL');
    await prisma.eventPassPurchase.update({ where: { id: first.body.data.purchaseId }, data: { purchasedAt: new Date(Date.now() - HOUR) } });
    const second = await buy(t, 'LARGE');
    expect(second.status).toBe(200);
    expect(second.body.data.reused).toBe(false);
  }, 60000);
});

describe('a pass only rises', () => {
  it('a cheaper purchase paid after a dearer one leaves the event on the dearer pass, and alerts', async () => {
    const small = referenceOf((await buy(t, 'SMALL')).body.data.authorizationUrl);
    // Past the reuse window, a LARGE is bought and paid first...
    await prisma.eventPassPurchase.updateMany({ where: { paymentRef: small }, data: { purchasedAt: new Date(Date.now() - HOUR) } });
    await buyAndPay(t, 'LARGE');
    expect((await passOf(t.eventId))?.passTier).toBe('LARGE');

    // ...then the abandoned SMALL checkout is paid late.
    clearSentEmails();
    await sendWebhook('charge.success', fakePaystack.pay(small));
    expect((await purchaseOf(small)).status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('LARGE');
    const succeeded = (await ledgerFor(small)).find((e) => e.type === 'EVENT_PASS_PURCHASE_SUCCEEDED');
    expect(succeeded?.payload).toMatchObject({ tierKept: true });
    expect(paymentAlerts().some((e) => /changed nothing/.test(e.subject))).toBe(true);
  }, 60000);
});

describe('Paystack failing at checkout', () => {
  it('a timeout: a neutral 503, the purchase FAILED, no raw text', async () => {
    fakePaystack.failNext('POST /transaction/initialize', 'timeout');
    const res = await buy(t, 'SMALL');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/timeout|Paystack did not/i);
    const purchase = await prisma.eventPassPurchase.findFirstOrThrow({ where: { eventId: t.eventId } });
    expect(purchase.status).toBe('FAILED');
    // A later success for it would still be granted (FAILED → PAID), so no
    // money can be lost to the uncertainty.
  }, 60000);

  it('a rejection: a neutral 422', async () => {
    fakePaystack.failNext('POST /transaction/initialize', { status: 400, body: { status: false, message: 'Invalid Email Address Passed' } });
    const res = await buy(t, 'SMALL');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYMENT_REJECTED');
    expect(res.body.message).not.toMatch(/Invalid Email/);
  }, 60000);
});

describe('the browser closed after paying, and a delayed webhook', () => {
  it('reconcile confirms by asking Paystack; the webhook arriving later changes nothing', async () => {
    const res = await buy(t, 'STANDARD');
    const reference = referenceOf(res.body.data.authorizationUrl);
    const data = fakePaystack.pay(reference);

    const reconcile = await request(app)
      .post(`/api/events/${t.eventId}/pass/purchases/${res.body.data.purchaseId}/reconcile`)
      .set(headersFor(t.admin));
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.data.status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('STANDARD');

    await sendWebhook('charge.success', data);
    const succeeded = (await ledgerFor(reference)).filter((e) => e.type === 'EVENT_PASS_PURCHASE_SUCCEEDED');
    expect(succeeded).toHaveLength(1);
  }, 60000);

  it('reconcile on a checkout still in progress leaves it pending; Paystack down is a neutral 503', async () => {
    const res = await buy(t, 'SMALL');
    const url = `/api/events/${t.eventId}/pass/purchases/${res.body.data.purchaseId}/reconcile`;
    // Not yet paid and not abandoned (an EFT clearing). An abandoned or
    // failed one is FAILED: payments-followups.test.ts.
    fakePaystack.transactions.get(referenceOf(res.body.data.authorizationUrl))!.status = 'ongoing';
    expect((await request(app).post(url).set(headersFor(t.admin))).body.data.status).toBe('PENDING');
    fakePaystack.failNext('GET /transaction/verify', { status: 503 }, 3);
    const down = await request(app).post(url).set(headersFor(t.admin));
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  }, 60000);

  it("another tenant can't reconcile this purchase", async () => {
    const res = await buy(t, 'SMALL');
    const other = await createPaymentsTenant();
    const attempt = await request(app)
      .post(`/api/events/${t.eventId}/pass/purchases/${res.body.data.purchaseId}/reconcile`)
      .set(headersFor(other.admin));
    expect(attempt.status).toBe(404);
  }, 60000);

  it('reconcile is rate limited per user', async () => {
    const res = await buy(t, 'SMALL');
    const url = `/api/events/${t.eventId}/pass/purchases/${res.body.data.purchaseId}/reconcile`;
    let last = 0;
    for (let i = 0; i <= PAYMENT_VERIFIES_PER_USER_PER_5_MIN; i++) {
      last = (await request(app).post(url).set(headersFor(t.admin))).status;
    }
    expect(last).toBe(429);
  }, 120000);
});

describe('abandoned checkouts: the stale sweep', () => {
  it('a day-old checkout Paystack calls abandoned becomes FAILED; a paid one is confirmed', async () => {
    const abandoned = referenceOf((await buy(t, 'SMALL')).body.data.authorizationUrl);
    await prisma.eventPassPurchase.updateMany({ where: { paymentRef: abandoned }, data: { purchasedAt: new Date(Date.now() - 25 * HOUR) } });
    const paid = referenceOf((await buy(t, 'LARGE')).body.data.authorizationUrl);
    await prisma.eventPassPurchase.updateMany({ where: { paymentRef: paid }, data: { purchasedAt: new Date(Date.now() - 26 * HOUR) } });
    fakePaystack.pay(paid);

    const result = await paymentMaintenanceService.sweepStalePending({ tenantIds: [t.tenantId] });
    expect(result).toMatchObject({ confirmed: 1, failed: 1 });
    expect((await purchaseOf(abandoned)).status).toBe('FAILED');
    expect((await purchaseOf(paid)).status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('LARGE');

    // The abandoned one paid after all, days later: still granted (and it
    // can't lower the LARGE pass).
    await sendWebhook('charge.success', fakePaystack.pay(abandoned));
    expect((await purchaseOf(abandoned)).status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('LARGE');
  }, 60000);
});

describe('refunds', () => {
  it('a full refund removes the pass: REFUNDED, the event back on its plan, REFUND_ISSUED recorded', async () => {
    const { reference } = await buyAndPay(t, 'STANDARD');
    const hook = await sendWebhook('refund.processed', {
      id: 'rf_full', transaction_reference: reference, amount: EVENT_PASS_PRICES_CENTS.STANDARD, currency: 'ZAR', status: 'processed',
    });
    expect(hook.status).toBe(200);
    expect((await purchaseOf(reference)).status).toBe('REFUNDED');
    expect(await passOf(t.eventId)).toBeNull();
    const refund = (await ledgerFor(reference)).find((e) => e.type === 'REFUND_ISSUED');
    expect(refund?.payload).toMatchObject({ product: 'EVENT_PASS', full: true, effect: 'PASS_REMOVED' });
    expect(await prisma.event.findUnique({ where: { id: t.eventId } })).not.toBeNull();

    const status = await request(app).get(`/api/events/${t.eventId}/pass`).set(headersFor(t.admin));
    expect(status.body.data.pass).toBeNull();
  }, 60000);

  it('refunding an upgrade puts the event back on the tier before it', async () => {
    await buyAndPay(t, 'SMALL');
    const upgrade = await buyAndPay(t, 'LARGE');
    expect((await passOf(t.eventId))?.passTier).toBe('LARGE');
    await sendWebhook('refund.processed', { id: 'rf_up', transaction: { id: upgrade.data['id'], reference: upgrade.reference }, amount: EVENT_PASS_PRICES_CENTS.LARGE - EVENT_PASS_PRICES_CENTS.SMALL, currency: 'ZAR' });
    expect((await passOf(t.eventId))?.passTier).toBe('SMALL');
  }, 60000);

  it('a partial refund is recorded and alerted; nothing is taken back', async () => {
    const { reference } = await buyAndPay(t, 'SMALL');
    clearSentEmails();
    await sendWebhook('refund.processed', { id: 'rf_part', transaction_reference: reference, amount: 1000, currency: 'ZAR' });
    expect((await purchaseOf(reference)).status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('SMALL');
    expect((await ledgerFor(reference)).find((e) => e.type === 'REFUND_ISSUED')?.payload).toMatchObject({ full: false, effect: 'PARTIAL_RECORDED_ONLY' });
    expect(paymentAlerts().some((e) => /needs a decision/.test(e.subject))).toBe(true);
  }, 60000);

  it('refund.pending is noted; refund.failed is noted and alerted; neither takes anything back', async () => {
    const { reference } = await buyAndPay(t, 'SMALL');
    clearSentEmails();
    await sendWebhook('refund.pending', { id: 'rf_p', transaction_reference: reference, amount: EVENT_PASS_PRICES_CENTS.SMALL, currency: 'ZAR' });
    await sendWebhook('refund.failed', { id: 'rf_p', transaction_reference: reference, amount: EVENT_PASS_PRICES_CENTS.SMALL, currency: 'ZAR' });
    expect((await purchaseOf(reference)).status).toBe('PAID');
    const types = (await ledgerFor(reference)).map((e) => e.type);
    expect(types).toContain('REFUND_PENDING');
    expect(types).toContain('REFUND_FAILED');
    expect(paymentAlerts().some((e) => /refund failed/.test(e.subject))).toBe(true);
  }, 60000);
});

describe('chargebacks', () => {
  const dispute = (reference: string, transactionId: unknown, extra: Record<string, unknown>) => ({
    id: 'dsp_1', refund_amount: EVENT_PASS_PRICES_CENTS.STANDARD, currency: 'ZAR', transaction: { id: transactionId, reference }, ...extra,
  });

  it('opened: recorded, access stays, the super admin alerted; lost: taken back (REVERSED)', async () => {
    const { reference, data } = await buyAndPay(t, 'STANDARD');
    clearSentEmails();
    await sendWebhook('charge.dispute.create', dispute(reference, data['id'], { status: 'awaiting-merchant-feedback' }));
    expect((await passOf(t.eventId))?.passTier).toBe('STANDARD');
    expect((await ledgerFor(reference)).map((e) => e.type)).toContain('DISPUTE_OPENED');
    expect(paymentAlerts().some((e) => /Chargeback opened/.test(e.subject))).toBe(true);

    await sendWebhook('charge.dispute.resolve', dispute(reference, data['id'], { status: 'resolved', resolution: 'merchant-accepted' }));
    expect((await purchaseOf(reference)).status).toBe('REVERSED');
    expect(await passOf(t.eventId)).toBeNull();
    expect((await ledgerFor(reference)).find((e) => e.type === 'DISPUTE_LOST')?.payload).toMatchObject({ effect: 'PASS_REMOVED' });
  }, 60000);

  it('won: recorded, nothing changes', async () => {
    const { reference, data } = await buyAndPay(t, 'STANDARD');
    await sendWebhook('charge.dispute.create', dispute(reference, data['id'], {}));
    await sendWebhook('charge.dispute.resolve', dispute(reference, data['id'], { status: 'resolved', resolution: 'declined' }));
    expect((await purchaseOf(reference)).status).toBe('PAID');
    expect((await passOf(t.eventId))?.passTier).toBe('STANDARD');
    expect((await ledgerFor(reference)).map((e) => e.type)).toContain('DISPUTE_WON');
  }, 60000);

  it('an outcome we don’t recognise changes nothing and is alerted', async () => {
    const { reference, data } = await buyAndPay(t, 'STANDARD');
    clearSentEmails();
    await sendWebhook('charge.dispute.resolve', dispute(reference, data['id'], { resolution: 'something-new' }));
    expect((await passOf(t.eventId))?.passTier).toBe('STANDARD');
    expect(paymentAlerts().some((e) => /don’t recognise/.test(e.subject))).toBe(true);
  }, 60000);
});
