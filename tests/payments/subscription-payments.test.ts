import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { prisma } from '../helpers/fixtures.js';
import { fakePaystack, type FakeSubscription } from '../helpers/fake-paystack.js';
import { sendWebhook } from '../helpers/paystack-webhook.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { resolveEffectiveTier } from '../../src/modules/subscription/effective-tier.util.js';
import { paymentMaintenanceService } from '../../src/modules/payment-reconciliation/payment-maintenance.service.js';
import { SUBSCRIPTION_PRICES_CENTS } from '../../src/modules/subscription/subscription-plans.config.js';
import {
  createPaymentsTenant,
  cleanupPayments,
  headersFor,
  installAuth,
  paymentAlerts,
  usePlanCodes,
  trackedReferences,
  PLAN,
  type PaymentsTenant,
} from './payments-fixtures.js';

// ─────────────────────────────────────────
//  SUBSCRIPTION PAYMENTS (payments release 1), end to end against the fake
//  Paystack with signed webhooks: subscribe, out-of-order and stale
//  webhooks (A1), upgrades, duplicates (A5), renewals and grace (B2), the
//  period-end hard stop, an uncertain plan change, refunds, chargebacks and
//  the verify fallback.
// ─────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const CELEBRATE_M = SUBSCRIPTION_PRICES_CENTS.CELEBRATE.MONTHLY;
const ELEVATE_M = SUBSCRIPTION_PRICES_CENTS.ELEVATE.MONTHLY;

const api = (t: PaymentsTenant) => ({
  subscribe: (tier: string, period: string) =>
    request(app).post('/api/subscriptions/subscribe').set(headersFor(t.admin)).send({ tier, period }),
  changeTier: (tier: string, period: string) =>
    request(app).put('/api/subscriptions/change-tier').set(headersFor(t.admin)).send({ tier, period }),
  cancel: () => request(app).post('/api/subscriptions/cancel').set(headersFor(t.admin)),
  status: () => request(app).get('/api/subscriptions').set(headersFor(t.admin)),
  verify: () => request(app).post('/api/subscriptions/verify').set(headersFor(t.admin)),
});

const tenantOf = (t: PaymentsTenant) => prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
const ledgerTypes = async (t: PaymentsTenant) =>
  (await prisma.paymentLedgerEntry.findMany({ where: { tenantId: t.tenantId }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);

const referenceOf = (url: string) => url.split('/').pop() as string;

// Subscribe, pay, and deliver Paystack's two webhooks (in the given order).
const subscribeAndActivate = async (
  t: PaymentsTenant,
  plan: { tier: string; period: string } = { tier: 'CELEBRATE', period: 'MONTHLY' },
  order: 'charge-first' | 'create-first' = 'charge-first'
): Promise<{ reference: string; sub: FakeSubscription; charge: Record<string, unknown> }> => {
  const res = await api(t).subscribe(plan.tier, plan.period);
  expect(res.status).toBe(200);
  const reference = referenceOf(res.body.data.authorizationUrl);
  trackedReferences.push(reference);
  const charge = fakePaystack.pay(reference);
  const sub = fakePaystack.subscriptionFor(t.email).at(-1)!;
  const create = fakePaystack.subscriptionCreateData(sub);
  if (order === 'charge-first') {
    await sendWebhook('charge.success', charge);
    await sendWebhook('subscription.create', create);
  } else {
    await sendWebhook('subscription.create', create);
    await sendWebhook('charge.success', charge);
  }
  return { reference, sub, charge };
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

describe('subscribing', () => {
  it('charge.success then subscription.create: on the plan, the charge recorded with its id and paid_at', async () => {
    const { reference, sub, charge } = await subscribeAndActivate(t);
    const tenant = await tenantOf(t);
    expect(tenant).toMatchObject({ subscriptionTier: 'CELEBRATE', subscriptionPeriod: 'MONTHLY', paystackSubscriptionCode: sub.subscription_code, subscriptionPendingReference: null });
    const success = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { paystackReference: reference, type: 'SUBSCRIPTION_CHARGE_SUCCEEDED' } });
    expect(success.paystackTransactionId).toBe(String(charge['id']));
    expect(success.occurredAt.toISOString()).toBe(charge['paid_at']);
  }, 60000);

  it('the other order (subscription.create first) ends the same way', async () => {
    await subscribeAndActivate(t, undefined, 'create-first');
    expect((await tenantOf(t)).subscriptionTier).toBe('CELEBRATE');
    expect((await ledgerTypes(t)).filter((x) => x === 'SUBSCRIPTION_CHARGE_SUCCEEDED')).toHaveLength(1);
  }, 60000);

  it('the same plan again reuses the checkout; another plan is 409; two at once start one checkout', async () => {
    const [a, b] = await Promise.all([api(t).subscribe('CELEBRATE', 'MONTHLY'), api(t).subscribe('CELEBRATE', 'MONTHLY')]);
    expect([a.status, b.status].sort()[0]).toBe(200);
    trackedReferences.push(referenceOf((a.body.data ?? b.body.data).authorizationUrl));
    const again = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    expect(again.body.data.reused).toBe(true);
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(1);
    const other = await api(t).subscribe('ELEVATE', 'ANNUAL');
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('PAYMENT_ALREADY_PENDING');
  }, 60000);

  it('Paystack failing at checkout: a neutral error and the attempt cleared', async () => {
    fakePaystack.failNext('POST /transaction/initialize', 'network');
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    expect(res.status).toBe(503);
    expect(res.body.message).not.toMatch(/fetch failed/);
    expect((await tenantOf(t)).subscriptionPendingReference).toBeNull();
  }, 60000);

  it('a first charge for the wrong amount is recorded as a mismatch and alerted', async () => {
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    const reference = referenceOf(res.body.data.authorizationUrl);
    trackedReferences.push(reference);
    await sendWebhook('charge.success', fakePaystack.pay(reference, { amount: 100 }));
    expect(await ledgerTypes(t)).toContain('PAYMENT_AMOUNT_MISMATCH');
    expect(await ledgerTypes(t)).not.toContain('SUBSCRIPTION_CHARGE_SUCCEEDED');
    expect(paymentAlerts().some((e) => /wrong amount/.test(e.subject))).toBe(true);
  }, 60000);

  it('a subscription.create whose plan amount isn’t our price activates nothing', async () => {
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    trackedReferences.push(referenceOf(res.body.data.authorizationUrl));
    const sub = fakePaystack.addSubscription({ email: t.email, plan_code: PLAN.CELEBRATE_MONTHLY, plan_amount: 100 });
    await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(sub));
    expect((await tenantOf(t)).subscriptionTier).toBe('SPARK');
  }, 60000);
});

describe('stale and out-of-order subscription webhooks (A1)', () => {
  it("a late disable for the old subscription after resubscribing doesn't cancel the new one", async () => {
    const first = await subscribeAndActivate(t);
    expect((await api(t).cancel()).status).toBe(200);
    expect((await tenantOf(t)).subscriptionCancelAtPeriodEnd).toBe(true);

    const second = await subscribeAndActivate(t, { tier: 'ELEVATE', period: 'MONTHLY' });
    expect(await tenantOf(t)).toMatchObject({ subscriptionTier: 'ELEVATE', subscriptionCancelAtPeriodEnd: false, paystackSubscriptionCode: second.sub.subscription_code });

    // The old subscription's period ends: Paystack disables it, late.
    await sendWebhook('subscription.disable', { id: 1, subscription_code: first.sub.subscription_code, status: 'complete', customer: { email: t.email, customer_code: first.sub.customer_code } });
    await sendWebhook('subscription.not_renew', { id: 2, subscription_code: first.sub.subscription_code, status: 'non-renewing', customer: { email: t.email } });

    expect(await tenantOf(t)).toMatchObject({ subscriptionTier: 'ELEVATE', subscriptionCancelAtPeriodEnd: false, paystackSubscriptionCode: second.sub.subscription_code });
    expect((await ledgerTypes(t)).filter((x) => x === 'WEBHOOK_EVENT_IGNORED')).toHaveLength(2);
  }, 60000);

  it('a disable for the CURRENT subscription still ends it at the period end', async () => {
    const { sub } = await subscribeAndActivate(t);
    await sendWebhook('subscription.disable', { id: 3, subscription_code: sub.subscription_code, customer: { email: t.email } });
    const tenant = await tenantOf(t);
    expect(tenant.subscriptionCancelAtPeriodEnd).toBe(true);
    expect(resolveEffectiveTier(tenant)).toBe('CELEBRATE');
  }, 60000);

  for (const order of ['create-then-disable', 'disable-then-create'] as const) {
    it(`an upgrade lands on the new plan, not ending, whichever webhook comes first (${order})`, async () => {
      const { sub: old } = await subscribeAndActivate(t);
      const res = await api(t).changeTier('ELEVATE', 'MONTHLY');
      expect(res.body.data).toEqual({ outcome: 'accepted' });
      const created = fakePaystack.subscriptionFor(t.email).find((s) => s.plan_code === PLAN.ELEVATE_MONTHLY)!;
      expect(fakePaystack.subscriptions.get(old.subscription_code)?.status).toBe('cancelled');

      const create = () => sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(created));
      const disable = () => sendWebhook('subscription.disable', { id: 4, subscription_code: old.subscription_code, customer: { email: t.email } });
      if (order === 'create-then-disable') { await create(); await disable(); } else { await disable(); await create(); }

      expect(await tenantOf(t)).toMatchObject({
        subscriptionTier: 'ELEVATE', subscriptionCancelAtPeriodEnd: false, paystackSubscriptionCode: created.subscription_code, subscriptionPendingReference: null,
      });
    }, 60000);
  }
});

describe('duplicate subscriptions (A5)', () => {
  it("a subscription.create the tenant didn't ask for, while it has a live one: recorded, the extra disabled, alerted", async () => {
    const { sub } = await subscribeAndActivate(t);
    clearSentEmails();
    const extra = fakePaystack.addSubscription({ email: t.email, plan_code: PLAN.ELEVATE_MONTHLY, plan_amount: ELEVATE_M });
    await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(extra));

    expect(await tenantOf(t)).toMatchObject({ subscriptionTier: 'CELEBRATE', paystackSubscriptionCode: sub.subscription_code });
    expect(fakePaystack.subscriptions.get(extra.subscription_code)?.status).toBe('cancelled');
    expect(await ledgerTypes(t)).toContain('SUBSCRIPTION_DUPLICATE_DETECTED');
    expect(paymentAlerts().some((e) => /second subscription/.test(e.subject))).toBe(true);
  }, 60000);
});

describe('renewals and grace (B2)', () => {
  const renewal = (sub: FakeSubscription, amount = CELEBRATE_M) =>
    fakePaystack.webhookDataFor(fakePaystack.addTransaction({ amount, email: t.email, plan: sub.plan_code }).reference);

  it('invoice.payment_failed starts the 5-day grace; invoice.update paid clears it and moves the period end', async () => {
    const { sub } = await subscribeAndActivate(t);
    await sendWebhook('invoice.payment_failed', {
      id: 11, invoice_code: 'INV_a', amount: CELEBRATE_M, currency: 'ZAR', paid: false, status: 'failed',
      subscription: { subscription_code: sub.subscription_code }, customer: { email: t.email },
    });
    let tenant = await tenantOf(t);
    expect(tenant.subscriptionGraceStartedAt).not.toBeNull();
    expect((await api(t).status()).body.data).toMatchObject({ inGrace: true, tier: 'CELEBRATE' });
    expect(resolveEffectiveTier(tenant, new Date(Date.now() + 6 * DAY))).toBe('SPARK');

    const next = new Date(Date.now() + 31 * DAY).toISOString();
    await sendWebhook('invoice.update', {
      id: 11, invoice_code: 'INV_a', amount: CELEBRATE_M, currency: 'ZAR', paid: true, status: 'success',
      subscription: { subscription_code: sub.subscription_code, next_payment_date: next }, customer: { email: t.email },
    });
    tenant = await tenantOf(t);
    expect(tenant.subscriptionGraceStartedAt).toBeNull();
    expect(tenant.subscriptionCurrentPeriodEnd?.toISOString()).toBe(next);
  }, 60000);

  it('an invoice for a subscription that is not current is ignored', async () => {
    const { sub } = await subscribeAndActivate(t);
    await sendWebhook('invoice.payment_failed', { id: 12, invoice_code: 'INV_b', amount: 1, paid: false, subscription: { subscription_code: 'SUB_not_current' }, customer: { email: t.email } });
    expect((await tenantOf(t)).subscriptionGraceStartedAt).toBeNull();
    expect(sub).toBeDefined();
  }, 60000);

  it('a renewal charge for the right amount clears grace and refreshes the period end from Paystack', async () => {
    const { sub } = await subscribeAndActivate(t);
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionGraceStartedAt: new Date() } });
    const next = new Date(Date.now() + 40 * DAY).toISOString();
    sub.next_payment_date = next;
    await sendWebhook('charge.success', renewal(sub));
    const tenant = await tenantOf(t);
    expect(tenant.subscriptionGraceStartedAt).toBeNull();
    expect(tenant.subscriptionCurrentPeriodEnd?.toISOString()).toBe(next);
    expect(tenant.subscriptionNeedsSync).toBe(false);
  }, 60000);

  it('a renewal charge for the wrong amount clears nothing and is recorded', async () => {
    const { sub } = await subscribeAndActivate(t);
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionGraceStartedAt: new Date() } });
    await sendWebhook('charge.success', renewal(sub, 100));
    expect((await tenantOf(t)).subscriptionGraceStartedAt).not.toBeNull();
    expect(await ledgerTypes(t)).toContain('PAYMENT_AMOUNT_MISMATCH');
  }, 60000);

  it("a renewal whose new period end can't be fetched stays flagged, and the hourly sync fixes it", async () => {
    const { sub } = await subscribeAndActivate(t);
    fakePaystack.failNext((c) => c.method === 'GET' && c.path.startsWith('/subscription/'), 'timeout', 3);
    const next = new Date(Date.now() + 45 * DAY).toISOString();
    sub.next_payment_date = next;
    await sendWebhook('charge.success', renewal(sub));
    expect((await tenantOf(t)).subscriptionNeedsSync).toBe(true);

    await paymentMaintenanceService.runHourly({ tenantIds: [t.tenantId] });
    const tenant = await tenantOf(t);
    expect(tenant.subscriptionNeedsSync).toBe(false);
    expect(tenant.subscriptionCurrentPeriodEnd?.toISOString()).toBe(next);
  }, 60000);

  it('the sync starts grace for a subscription Paystack says needs attention', async () => {
    const { sub } = await subscribeAndActivate(t);
    sub.status = 'attention';
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionNeedsSync: true } });
    await paymentMaintenanceService.runHourly({ tenantIds: [t.tenantId] });
    expect((await tenantOf(t)).subscriptionGraceStartedAt).not.toBeNull();
    expect(await ledgerTypes(t)).toContain('SUBSCRIPTION_SYNC_CORRECTED');
  }, 60000);
});

describe('the period-end hard stop', () => {
  const base = { subscriptionTier: 'ELEVATE' as const, subscriptionCancelAtPeriodEnd: false, subscriptionGraceStartedAt: null };
  it('a paid period that ended over 5 days ago with no renewal is Spark', () => {
    const now = new Date('2026-12-20T00:00:00Z');
    expect(resolveEffectiveTier({ ...base, subscriptionCurrentPeriodEnd: new Date('2026-12-14T00:00:00Z') }, now)).toBe('SPARK');
    expect(resolveEffectiveTier({ ...base, subscriptionCurrentPeriodEnd: new Date('2026-12-16T00:00:00Z') }, now)).toBe('ELEVATE');
    expect(resolveEffectiveTier({ ...base, subscriptionCurrentPeriodEnd: null }, now)).toBe('ELEVATE');
  });

  it('a tenant waiting for the sync after a successful charge keeps its plan', () => {
    const now = new Date('2026-12-20T00:00:00Z');
    expect(resolveEffectiveTier({ ...base, subscriptionCurrentPeriodEnd: new Date('2026-12-01T00:00:00Z'), subscriptionNeedsSync: true }, now)).toBe('ELEVATE');
  });
});

describe('a plan change with no clear answer', () => {
  it('is pending_confirmation and UNCERTAIN, never FAILED; the sync adopts the subscription Paystack made', async () => {
    const { sub: old } = await subscribeAndActivate(t);
    fakePaystack.failNext((c) => c.method === 'POST' && c.path === '/subscription', 'timeout');
    const res = await api(t).changeTier('ELEVATE', 'MONTHLY');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ outcome: 'pending_confirmation' });
    let types = await ledgerTypes(t);
    expect(types).toContain('SUBSCRIPTION_CHARGE_UNCERTAIN');
    expect(types.filter((x) => x === 'SUBSCRIPTION_CHARGE_FAILED')).toHaveLength(0);
    expect((await tenantOf(t)).subscriptionNeedsSync).toBe(true);

    // Paystack had created it after all; its webhook never came.
    const made = fakePaystack.addSubscription({ email: t.email, plan_code: PLAN.ELEVATE_MONTHLY, plan_amount: ELEVATE_M, customer_code: old.customer_code });
    await paymentMaintenanceService.runHourly({ tenantIds: [t.tenantId] });

    expect(await tenantOf(t)).toMatchObject({ subscriptionTier: 'ELEVATE', paystackSubscriptionCode: made.subscription_code, subscriptionNeedsSync: false });
    types = await ledgerTypes(t);
    expect(types).toContain('SUBSCRIPTION_SYNC_CORRECTED');
  }, 60000);

  it('a clear rejection is FAILED with a neutral message', async () => {
    await subscribeAndActivate(t);
    fakePaystack.failNext((c) => c.method === 'POST' && c.path === '/subscription', { status: 400, body: { status: false, message: 'Authorization is invalid' } });
    const res = await api(t).changeTier('ELEVATE', 'MONTHLY');
    expect(res.status).toBe(422);
    expect(res.body.message).not.toMatch(/Authorization/);
    expect(await ledgerTypes(t)).toContain('SUBSCRIPTION_CHARGE_FAILED');
  }, 60000);
});

describe('refunds and chargebacks', () => {
  it('a full refund of the latest charge ends the subscription at once: Spark, disabled at Paystack, data kept', async () => {
    const { reference, sub } = await subscribeAndActivate(t);
    await sendWebhook('refund.processed', { id: 'rf_sub', transaction_reference: reference, amount: CELEBRATE_M, currency: 'ZAR' });
    const tenant = await tenantOf(t);
    expect(tenant.subscriptionTier).toBe('SPARK');
    expect(resolveEffectiveTier(tenant)).toBe('SPARK');
    expect(fakePaystack.subscriptions.get(sub.subscription_code)?.status).toBe('cancelled');
    expect(tenant.paystackSubscriptionCode).toBeNull();
    expect(await prisma.event.findUnique({ where: { id: t.eventId } })).not.toBeNull();
    const refund = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { tenantId: t.tenantId, type: 'REFUND_ISSUED' } });
    expect(refund.payload).toMatchObject({ product: 'SUBSCRIPTION', effect: 'SUBSCRIPTION_ENDED' });
    const history = await request(app).get('/api/billing-history').set(headersFor(t.admin));
    expect(history.body.data.some((h: { description: string }) => h.description === 'Refund: Subscription')).toBe(true);
  }, 60000);

  it("if Paystack can't be reached to disable it, the sync does it later", async () => {
    const { reference, sub } = await subscribeAndActivate(t);
    fakePaystack.failNext('POST /subscription/disable', 'network');
    await sendWebhook('refund.processed', { id: 'rf_sub2', transaction_reference: reference, amount: CELEBRATE_M, currency: 'ZAR' });
    expect((await tenantOf(t)).subscriptionNeedsSync).toBe(true);
    expect(fakePaystack.subscriptions.get(sub.subscription_code)?.status).toBe('active');
    await paymentMaintenanceService.runHourly({ tenantIds: [t.tenantId] });
    expect(fakePaystack.subscriptions.get(sub.subscription_code)?.status).toBe('cancelled');
    expect((await tenantOf(t)).paystackSubscriptionCode).toBeNull();
  }, 60000);

  it('a refund of an earlier charge is recorded and alerted; the subscription stays', async () => {
    const { reference, sub } = await subscribeAndActivate(t);
    const later = fakePaystack.addTransaction({ amount: CELEBRATE_M, email: t.email, plan: sub.plan_code });
    await sendWebhook('charge.success', fakePaystack.webhookDataFor(later.reference));
    clearSentEmails();
    await sendWebhook('refund.processed', { id: 'rf_old', transaction_reference: reference, amount: CELEBRATE_M, currency: 'ZAR' });
    expect((await tenantOf(t)).subscriptionTier).toBe('CELEBRATE');
    expect(paymentAlerts().some((e) => /needs a decision/.test(e.subject))).toBe(true);
  }, 60000);

  it('a lost chargeback on the latest charge ends it like a refund', async () => {
    const { reference, charge } = await subscribeAndActivate(t);
    await sendWebhook('charge.dispute.create', { id: 'dsp_s', refund_amount: CELEBRATE_M, currency: 'ZAR', transaction: { id: charge['id'], reference } });
    expect((await tenantOf(t)).subscriptionTier).toBe('CELEBRATE');
    await sendWebhook('charge.dispute.resolve', { id: 'dsp_s', refund_amount: CELEBRATE_M, currency: 'ZAR', resolution: 'merchant-accepted', transaction: { id: charge['id'], reference } });
    expect((await tenantOf(t)).subscriptionTier).toBe('SPARK');
  }, 60000);
});

describe('the verify fallback', () => {
  it('paid, but no webhook has come: POST /verify activates the subscription', async () => {
    const res = await api(t).subscribe('ELEVATE', 'ANNUAL');
    const reference = referenceOf(res.body.data.authorizationUrl);
    trackedReferences.push(reference);
    fakePaystack.pay(reference);

    const verified = await api(t).verify();
    expect(verified.status).toBe(200);
    expect(verified.body.data).toMatchObject({ tier: 'ELEVATE', period: 'ANNUAL', pendingChange: null });
    expect(await ledgerTypes(t)).toContain('SUBSCRIPTION_CHARGE_SUCCEEDED');

    // The webhooks arriving afterwards change nothing more.
    await sendWebhook('charge.success', fakePaystack.webhookDataFor(reference));
    await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(fakePaystack.subscriptionFor(t.email)[0]!));
    expect((await ledgerTypes(t)).filter((x) => x === 'SUBSCRIPTION_CHARGE_SUCCEEDED')).toHaveLength(1);
  }, 60000);

  it('not paid yet (Paystack still processing it): pending, nothing changes', async () => {
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    const reference = referenceOf(res.body.data.authorizationUrl);
    trackedReferences.push(reference);
    // Not settled either way. (Abandoned or failed, the payer has left: the
    // attempt ends; tests/payments/subscription-state.test.ts.)
    fakePaystack.transactions.get(reference)!.status = 'ongoing';
    const verified = await api(t).verify();
    expect(verified.body.data).toMatchObject({ tier: 'SPARK', pendingChange: { tier: 'CELEBRATE', period: 'MONTHLY' } });
  }, 60000);

  it('a day-old unpaid attempt is cleared by the stale sweep', async () => {
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    trackedReferences.push(referenceOf(res.body.data.authorizationUrl));
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionPendingStartedAt: new Date(Date.now() - 2 * DAY) } });
    await paymentMaintenanceService.sweepStalePending({ tenantIds: [t.tenantId] });
    expect((await tenantOf(t)).subscriptionPendingReference).toBeNull();
  }, 60000);
});
