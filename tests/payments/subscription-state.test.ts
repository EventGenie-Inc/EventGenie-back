import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type Prisma } from '@prisma/client';
import app from '../../src/app.js';
import { prisma } from '../helpers/fixtures.js';
import { fakePaystack, type FakeSubscription } from '../helpers/fake-paystack.js';
import { sendWebhook } from '../helpers/paystack-webhook.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { frontendUrl } from '../../src/shared/utils/frontend-url.util.js';
import { paymentMaintenanceService } from '../../src/modules/payment-reconciliation/payment-maintenance.service.js';
import { subscriptionRepository } from '../../src/modules/subscription/subscription.repository.js';
import { needsSettlingOnSpark } from '../../src/modules/subscription/subscription-state.util.js';
import { customTierService } from '../../src/modules/custom-tier/custom-tier.service.js';
import { SUBSCRIPTION_PRICES_CENTS } from '../../src/modules/subscription/subscription-plans.config.js';
import { createCustomTier, onCustomTier } from '../custom-tiers/custom-tier-fixtures.js';
import {
  createPaymentsTenant,
  createSuperAdmin,
  cleanupPayments,
  headersFor,
  installAuth,
  usePlanCodes,
  trackedReferences,
  type PaymentsTenant,
} from './payments-fixtures.js';

// ─────────────────────────────────────────
//  A SUBSCRIPTION'S STATE (fix/subscription-state; STEERING "Payments")
//
//  - On Spark with no live subscription, nothing describes one any more
//    (settled: the sweep, a disable, the sync, a custom tier removed, and the
//    repair migration for rows already in that state).
//  - The status never says a plan "ends" without a paid tier and a date, and
//    says plainly whether the tenant can subscribe (canSubscribe).
//  - A cancelled or declined checkout ends its attempt when the callback
//    verifies, so the next click starts again; every checkout carries
//    Paystack's cancel action back to its callback, marked cancelled.
//  - latestPayment is the latest paid charge, unclaimed ones included when
//    they are certainly the tenant's.
// ─────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const CELEBRATE_M = SUBSCRIPTION_PRICES_CENTS.CELEBRATE.MONTHLY;

const api = (t: PaymentsTenant) => ({
  subscribe: (tier: string, period: string) =>
    request(app).post('/api/subscriptions/subscribe').set(headersFor(t.admin)).send({ tier, period }),
  cancel: () => request(app).post('/api/subscriptions/cancel').set(headersFor(t.admin)),
  status: () => request(app).get('/api/subscriptions').set(headersFor(t.admin)),
  verify: () => request(app).post('/api/subscriptions/verify').set(headersFor(t.admin)),
});

const tenantOf = (t: PaymentsTenant) => prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
const referenceOf = (url: string) => url.split('/').pop() as string;
const setBilling = (t: PaymentsTenant, data: Prisma.TenantUpdateInput) => prisma.tenant.update({ where: { id: t.tenantId }, data });

// Subscribe, pay, and deliver Paystack's two webhooks.
const subscribeAndActivate = async (t: PaymentsTenant): Promise<{ reference: string; sub: FakeSubscription }> => {
  const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
  expect(res.status).toBe(200);
  const reference = referenceOf(res.body.data.authorizationUrl);
  trackedReferences.push(reference);
  await sendWebhook('charge.success', fakePaystack.pay(reference));
  const sub = fakePaystack.subscriptionFor(t.email).at(-1)!;
  await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(sub));
  return { reference, sub };
};

// What the dev tenant looked like: Spark, "cancelling", no period, no
// subscription (the pre-release-1 disable handler matched it by email).
const DEV_STATE: Prisma.TenantUpdateInput = {
  subscriptionTier: 'SPARK',
  subscriptionPeriod: null,
  subscriptionCurrentPeriodEnd: null,
  subscriptionCancelAtPeriodEnd: true,
  paystackSubscriptionCode: null,
  paystackCustomerCode: null,
};

const CLEAN_SPARK = {
  subscriptionTier: 'SPARK',
  subscriptionPeriod: null,
  subscriptionCurrentPeriodEnd: null,
  subscriptionCancelAtPeriodEnd: false,
  subscriptionPendingTierAfterPeriodEnd: null,
  subscriptionGraceStartedAt: null,
  paystackSubscriptionCode: null,
  paystackSubscriptionEmailToken: null,
};

let t: PaymentsTenant;
const customTierIds: string[] = [];

beforeEach(async () => {
  installAuth();
  usePlanCodes();
  clearSentEmails();
  t = await createPaymentsTenant();
}, 60000);

afterEach(async () => {
  vi.unstubAllEnvs();
  if (customTierIds.length) {
    await prisma.tenant.updateMany({ where: { customTierId: { in: customTierIds } }, data: { customTierId: null } });
    await prisma.adminAuditEntry.deleteMany({ where: { tenantId: t.tenantId } });
    await prisma.customTier.deleteMany({ where: { id: { in: customTierIds } } });
    customTierIds.length = 0;
  }
  await cleanupPayments();
}, 120000);

describe('a cancelled subscription that ends leaves a clean Spark state', () => {
  it('the hourly run settles it once its period is over: no tier, period, end, cancel marker or code; recorded; can subscribe again', async () => {
    await subscribeAndActivate(t);
    expect((await api(t).cancel()).status).toBe(200);
    // Still inside its period: untouched, and the status says when it ends.
    await paymentMaintenanceService.runHourly({ tenantIds: [t.tenantId] });
    const during = (await api(t).status()).body.data;
    expect(during).toMatchObject({ tier: 'CELEBRATE', cancelAtPeriodEnd: true, canSubscribe: true });
    expect(during.currentPeriodEnd).not.toBeNull();

    await setBilling(t, { subscriptionCurrentPeriodEnd: new Date(Date.now() - DAY) });
    await paymentMaintenanceService.runHourly({ tenantIds: [t.tenantId] });

    expect(await tenantOf(t)).toMatchObject(CLEAN_SPARK);
    const row = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { tenantId: t.tenantId, type: 'SUBSCRIPTION_SYNC_CORRECTED' } });
    expect(row.payload).toMatchObject({ changes: ['SETTLED_ON_SPARK'], reason: 'ENDED', before: { tier: 'CELEBRATE', cancelAtPeriodEnd: true } });

    const status = (await api(t).status()).body.data;
    expect(status).toMatchObject({ tier: 'SPARK', period: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, canSubscribe: true, cannotSubscribeReason: null });

    // And a second run changes nothing more.
    await paymentMaintenanceService.runHourly({ tenantIds: [t.tenantId] });
    expect(await prisma.paymentLedgerEntry.count({ where: { tenantId: t.tenantId, type: 'SUBSCRIPTION_SYNC_CORRECTED' } })).toBe(1);

    // Subscribing again works and activates.
    await subscribeAndActivate(t);
    expect(await tenantOf(t)).toMatchObject({ subscriptionTier: 'CELEBRATE', subscriptionCancelAtPeriodEnd: false });
  }, 60000);

  it('subscription.disable for the current subscription after its period has ended settles it at once', async () => {
    const { sub } = await subscribeAndActivate(t);
    await setBilling(t, { subscriptionCurrentPeriodEnd: new Date(Date.now() - DAY) });
    await sendWebhook('subscription.disable', { ...fakePaystack.subscriptionCreateData(sub), status: 'cancelled' });
    expect(await tenantOf(t)).toMatchObject(CLEAN_SPARK);
  }, 60000);

  it('left alone: a live subscription past its hard stop (Paystack may still renew it), and a refund waiting to be disabled', async () => {
    const { sub } = await subscribeAndActivate(t);
    await setBilling(t, { subscriptionCurrentPeriodEnd: new Date(Date.now() - 10 * DAY) });
    await subscriptionService_settle(t);
    expect((await tenantOf(t)).paystackSubscriptionCode).toBe(sub.subscription_code);

    await setBilling(t, { subscriptionTier: 'SPARK', subscriptionPeriod: null, subscriptionCurrentPeriodEnd: null, subscriptionNeedsSync: true });
    await subscriptionService_settle(t);
    expect((await tenantOf(t)).paystackSubscriptionCode).toBe(sub.subscription_code);
  }, 60000);

  it('taking a custom tier off a tenant with stale billing fields settles it', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    await setBilling(t, DEV_STATE);
    await onCustomTier(t.tenantId, tier.id);
    const superAdmin = await createSuperAdmin();
    await customTierService.unassign(t.tenantId, superAdmin.id);
    expect(await tenantOf(t)).toMatchObject(CLEAN_SPARK);
    await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  }, 60000);
});

// The sweep alone (the hourly run also syncs).
const subscriptionService_settle = async (t: PaymentsTenant) => {
  const { subscriptionService } = await import('../../src/modules/subscription/subscription.service.js');
  return subscriptionService.settleEnded({ tenantIds: [t.tenantId] });
};

describe('a Spark tenant with old cancelled subscriptions can subscribe', () => {
  it('the dev tenant state: canSubscribe true, no "ends", and subscribe starts a checkout', async () => {
    await setBilling(t, DEV_STATE);
    const status = (await api(t).status()).body.data;
    expect(status).toMatchObject({
      tier: 'SPARK',
      period: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      pendingTierAfterPeriodEnd: null,
      canSubscribe: true,
      cannotSubscribeReason: null,
    });
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    expect(res.status).toBe(200);
    trackedReferences.push(referenceOf(res.body.data.authorizationUrl));
  }, 60000);

  it('the sweep repairs that state', async () => {
    await setBilling(t, DEV_STATE);
    await subscriptionService_settle(t);
    expect(await tenantOf(t)).toMatchObject(CLEAN_SPARK);
  }, 60000);
});

describe('the status never says a plan ends without a paid tier and a date', () => {
  const cases: { name: string; data: Prisma.TenantUpdateInput; ends: boolean }[] = [
    { name: 'Spark, cancelling, no date (the dev tenant)', data: DEV_STATE, ends: false },
    { name: 'a paid tier, cancelling, no date', data: { subscriptionTier: 'CELEBRATE', subscriptionPeriod: 'MONTHLY', subscriptionCancelAtPeriodEnd: true, subscriptionCurrentPeriodEnd: null }, ends: false },
    { name: 'a paid tier, cancelled, its date passed', data: { subscriptionTier: 'CELEBRATE', subscriptionPeriod: 'MONTHLY', subscriptionCancelAtPeriodEnd: true, subscriptionCurrentPeriodEnd: new Date(Date.now() - DAY), subscriptionPendingTierAfterPeriodEnd: 'CELEBRATE' }, ends: false },
    { name: 'Spark, a pending downgrade left behind', data: { subscriptionTier: 'SPARK', subscriptionPendingTierAfterPeriodEnd: 'CELEBRATE', subscriptionCancelAtPeriodEnd: true }, ends: false },
    { name: 'a paid tier, cancelled, ending in 10 days', data: { subscriptionTier: 'ELEVATE', subscriptionPeriod: 'MONTHLY', subscriptionCancelAtPeriodEnd: true, subscriptionCurrentPeriodEnd: new Date(Date.now() + 10 * DAY), subscriptionPendingTierAfterPeriodEnd: 'CELEBRATE' }, ends: true },
  ];

  it.each(cases)('$name', async ({ data, ends }) => {
    await setBilling(t, data);
    const s = (await api(t).status()).body.data;
    expect(s.cancelAtPeriodEnd).toBe(ends);
    if (ends) {
      expect(s.tier).not.toBe('SPARK');
      expect(new Date(s.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now());
      expect(s.pendingTierAfterPeriodEnd).toBe('CELEBRATE');
    } else {
      expect(s).toMatchObject({ tier: 'SPARK', period: null, currentPeriodEnd: null, pendingTierAfterPeriodEnd: null, inGrace: false, graceDeadline: null });
    }
  }, 60000);
});

describe('canSubscribe says why not', () => {
  it('an active subscription: SUBSCRIPTION_ACTIVE, and subscribe refuses with the same reason', async () => {
    await subscribeAndActivate(t);
    expect((await api(t).status()).body.data).toMatchObject({ canSubscribe: false, cannotSubscribeReason: 'SUBSCRIPTION_ACTIVE' });
    const res = await api(t).subscribe('ELEVATE', 'MONTHLY');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SUBSCRIPTION_NOT_AVAILABLE', details: { reason: 'SUBSCRIPTION_ACTIVE' } });
  }, 60000);

  it('a checkout in progress: CHECKOUT_PENDING with its link; after 30 minutes it no longer holds', async () => {
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    trackedReferences.push(referenceOf(res.body.data.authorizationUrl));
    expect((await api(t).status()).body.data).toMatchObject({
      canSubscribe: false,
      cannotSubscribeReason: 'CHECKOUT_PENDING',
      pendingChange: { tier: 'CELEBRATE', period: 'MONTHLY', isPlanChange: false, authorizationUrl: res.body.data.authorizationUrl },
    });
    await setBilling(t, { subscriptionPendingStartedAt: new Date(Date.now() - 31 * 60 * 1000) });
    expect((await api(t).status()).body.data).toMatchObject({ canSubscribe: true, cannotSubscribeReason: null });
  }, 60000);

  it('a custom tier is no reason not to: a trial converts by subscribing, and the paid plan takes it off the custom tier', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    await onCustomTier(t.tenantId, tier.id);
    expect((await api(t).status()).body.data).toMatchObject({ customTier: { id: tier.id }, canSubscribe: true, cannotSubscribeReason: null });

    await subscribeAndActivate(t);
    expect(await tenantOf(t)).toMatchObject({ customTierId: null, subscriptionTier: 'CELEBRATE' });
    expect((await api(t).status()).body.data).toMatchObject({ customTier: null, tier: 'CELEBRATE', canSubscribe: false, cannotSubscribeReason: 'SUBSCRIPTION_ACTIVE' });
  }, 60000);

  it('on a custom tier, another reason still applies: a checkout in progress', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    await onCustomTier(t.tenantId, tier.id);
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    expect(res.status).toBe(200);
    trackedReferences.push(referenceOf(res.body.data.authorizationUrl));
    expect((await api(t).status()).body.data).toMatchObject({ canSubscribe: false, cannotSubscribeReason: 'CHECKOUT_PENDING' });
  }, 60000);
});

describe('a cancelled or declined checkout frees the next attempt', () => {
  const cancelActionOf = (index = 0) =>
    new URL((fakePaystack.callsTo('POST', '/transaction/initialize')[index]!.body as { metadata: { cancel_action: string } }).metadata.cancel_action);

  it("subscribe sends Paystack's cancel action: the billing callback, marked cancelled, with our reference", async () => {
    const res = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    const reference = referenceOf(res.body.data.authorizationUrl);
    trackedReferences.push(reference);
    const cancel = cancelActionOf();
    expect(`${cancel.origin}${cancel.pathname}`).toBe(frontendUrl('/billing/callback'));
    expect(cancel.searchParams.get('cancelled')).toBe('true');
    expect(cancel.searchParams.get('reference')).toBe(reference);
  }, 60000);

  it.each(['cancelled (abandoned)', 'declined (failed)'])('%s: verify ends the attempt and the next plan starts a new checkout at once', async (how) => {
    const first = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    const reference = referenceOf(first.body.data.authorizationUrl);
    trackedReferences.push(reference);
    if (how.startsWith('declined')) fakePaystack.fail(reference);

    const verified = await api(t).verify();
    expect(verified.status).toBe(200);
    expect(verified.body.data).toMatchObject({ pendingChange: null, canSubscribe: true, latestPayment: { status: 'FAILED' } });

    const next = await api(t).subscribe('ELEVATE', 'MONTHLY');
    expect(next.status).toBe(200);
    expect(next.body.data.reused).toBe(false);
    trackedReferences.push(referenceOf(next.body.data.authorizationUrl));
  }, 60000);

  it('a cancelled checkout paid after all (another tab) is still recorded and activated', async () => {
    const first = await api(t).subscribe('CELEBRATE', 'MONTHLY');
    const reference = referenceOf(first.body.data.authorizationUrl);
    trackedReferences.push(reference);
    await api(t).verify();
    expect((await tenantOf(t)).subscriptionPendingReference).toBeNull();

    // No pending attempt and no customer code yet: matched by our own reference.
    await sendWebhook('charge.success', fakePaystack.pay(reference));
    const success = await prisma.paymentLedgerEntry.findFirst({ where: { paystackReference: reference, type: 'SUBSCRIPTION_CHARGE_SUCCEEDED' } });
    expect(success?.tenantId).toBe(t.tenantId);
    await sendWebhook('subscription.create', fakePaystack.subscriptionCreateData(fakePaystack.subscriptionFor(t.email).at(-1)!));
    expect((await api(t).status()).body.data).toMatchObject({ tier: 'CELEBRATE', latestPayment: { status: 'PAID', amountCents: CELEBRATE_M } });
  }, 60000);

  it("Event Pass: the cancel action returns to the pass callback; a cancelled checkout's reconcile frees the next one", async () => {
    const buy = (passTier: string) => request(app).post(`/api/events/${t.eventId}/pass/purchase`).set(headersFor(t.admin)).send({ passTier });
    const first = await buy('SMALL');
    expect(first.status).toBe(200);
    const reference = referenceOf(first.body.data.authorizationUrl);
    const cancel = cancelActionOf();
    expect(`${cancel.origin}${cancel.pathname}`).toBe(frontendUrl('/billing/event-pass/callback'));
    expect(cancel.searchParams.get('cancelled')).toBe('true');
    expect(cancel.searchParams.get('reference')).toBe(reference);

    expect((await buy('LARGE')).status).toBe(409);
    const reconciled = await request(app)
      .post(`/api/events/${t.eventId}/pass/purchases/${first.body.data.purchaseId}/reconcile`)
      .set(headersFor(t.admin));
    expect(reconciled.body.data.status).toBe('FAILED');
    expect((await buy('LARGE')).status).toBe(200);
  }, 60000);

  it('SMS bundle: the cancel action returns to the bundle callback', async () => {
    await prisma.eventPass.create({ data: { eventId: t.eventId, tenantId: t.tenantId, passTier: 'STANDARD' } });
    const res = await request(app).post(`/api/events/${t.eventId}/pass/sms-bundle/purchase`).set(headersFor(t.admin)).send({ smsCount: 50 });
    expect(res.status).toBe(200);
    const cancel = cancelActionOf();
    expect(`${cancel.origin}${cancel.pathname}`).toBe(frontendUrl('/billing/event-pass/sms-bundle/callback'));
    expect(cancel.searchParams.get('reference')).toBe(referenceOf(res.body.data.authorizationUrl));
    expect(cancel.searchParams.get('cancelled')).toBe('true');
  }, 60000);
});

describe('latestPayment is the latest paid charge', () => {
  it('a renewal after the first charge: the renewal, PAID, with its amount and paid_at', async () => {
    const { sub } = await subscribeAndActivate(t);
    const paidAt = new Date(Date.now() + 1000).toISOString();
    const renewal = fakePaystack.addTransaction({ amount: CELEBRATE_M, email: t.email, plan: sub.plan_code, paidAt });
    trackedReferences.push(renewal.reference);
    await sendWebhook('charge.success', fakePaystack.webhookDataFor(renewal.reference));
    const latest = (await api(t).status()).body.data.latestPayment;
    expect(latest).toMatchObject({ status: 'PAID', amountCents: CELEBRATE_M, occurredAt: paidAt });
  }, 60000);

  // Rows as the ledger holds them from before the fix: a charge for the
  // tenant's own checkout that nothing claimed.
  const unclaimed = async (reference: string, data: Record<string, unknown>) => {
    trackedReferences.push(reference);
    return prisma.paymentLedgerEntry.create({
      data: {
        type: 'WEBHOOK_EVENT_UNHANDLED',
        amountCents: CELEBRATE_M,
        currency: 'ZAR',
        paystackReference: reference,
        relatedType: 'webhook',
        relatedId: 'charge.success',
        payload: { event: 'charge.success', data: { reference, status: 'success', amount: CELEBRATE_M, ...data } } as Prisma.InputJsonValue,
      },
    });
  };

  it("an unclaimed charge for the tenant's own checkout (by our reference) counts", async () => {
    const reference = `sub_${randomUUID().replace(/-/g, '')}`;
    await prisma.paymentLedgerEntry.create({
      data: { type: 'SUBSCRIPTION_CHARGE_INITIATED', amountCents: CELEBRATE_M, currency: 'ZAR', tenantId: t.tenantId, paystackReference: reference, relatedType: 'Tenant', relatedId: t.tenantId, payload: { tier: 'CELEBRATE', period: 'MONTHLY' } },
    });
    await unclaimed(reference, { customer: { customer_code: 'CUS_unknown_then', email: 'someone@payments.test' } });
    expect((await api(t).status()).body.data.latestPayment).toMatchObject({ status: 'PAID', amountCents: CELEBRATE_M });
  }, 60000);

  it("by the tenant's customer code it counts only as a plan charge; by email alone it never does", async () => {
    const code = `CUS_${randomUUID().slice(0, 12)}`;
    await setBilling(t, { paystackCustomerCode: code });
    await unclaimed(`T${randomUUID().slice(0, 10)}`, { customer: { customer_code: code, email: t.email } });
    await unclaimed(`T${randomUUID().slice(0, 10)}`, { customer: { customer_code: 'CUS_someone_else', email: t.email }, plan: { plan_code: 'PLN_x' } });
    expect((await api(t).status()).body.data.latestPayment).toBeNull();

    await unclaimed(`T${randomUUID().slice(0, 10)}`, { customer: { customer_code: code, email: t.email }, plan: { plan_code: 'PLN_x' } });
    expect((await api(t).status()).body.data.latestPayment).toMatchObject({ status: 'PAID' });
  }, 60000);
});

describe('the repair migration (scoped to these tenants)', () => {
  it('repairs exactly the rows needsSettlingOnSpark would, with a ledger row each', async () => {
    const others = await Promise.all([createPaymentsTenant(), createPaymentsTenant(), createPaymentsTenant(), createPaymentsTenant()]);
    const [live, ending, refundWaiting, pastHardStop] = others as [PaymentsTenant, PaymentsTenant, PaymentsTenant, PaymentsTenant];
    await setBilling(t, DEV_STATE);
    await setBilling(live, { subscriptionTier: 'CELEBRATE', subscriptionPeriod: 'MONTHLY', subscriptionCurrentPeriodEnd: new Date(Date.now() - 20 * DAY), paystackSubscriptionCode: `SUB_${randomUUID()}` });
    await setBilling(ending, { subscriptionTier: 'CELEBRATE', subscriptionPeriod: 'MONTHLY', subscriptionCurrentPeriodEnd: new Date(Date.now() + 5 * DAY), subscriptionCancelAtPeriodEnd: true, paystackSubscriptionCode: `SUB_${randomUUID()}` });
    await setBilling(refundWaiting, { subscriptionTier: 'SPARK', paystackSubscriptionCode: `SUB_${randomUUID()}`, subscriptionNeedsSync: true });
    await setBilling(pastHardStop, { subscriptionTier: 'ELEVATE', subscriptionPeriod: 'ANNUAL', subscriptionCurrentPeriodEnd: new Date(Date.now() - 20 * DAY), paystackSubscriptionCode: null });

    const all = [t, live, ending, refundWaiting, pastHardStop];
    const ids = all.map((x) => x.tenantId);
    const expected = new Map<string, boolean>();
    for (const x of all) expected.set(x.tenantId, needsSettlingOnSpark((await subscriptionRepository.findBillingStateByTenantId(x.tenantId))!));
    expect([...expected.values()]).toEqual([true, false, false, false, true]);

    // The migration's one statement, scoped to these tenants (STEERING §6:
    // never over whole tables in a test).
    const sql = fs.readFileSync(path.resolve('prisma/migrations/20261121100000_settle_ended_subscriptions/migration.sql'), 'utf8');
    const anchor = '  FROM "Tenant"\n  WHERE ';
    expect(sql.split(anchor)).toHaveLength(2);
    const scoped = sql.replace(anchor, `  FROM "Tenant"\n  WHERE "id" IN (${ids.map((id) => `'${id}'`).join(', ')}) AND `);
    await prisma.$executeRawUnsafe(scoped.split('\n').filter((l) => !l.startsWith('--')).join('\n'));

    for (const x of all) {
      const row = await tenantOf(x);
      const rows = await prisma.paymentLedgerEntry.count({ where: { tenantId: x.tenantId, type: 'SUBSCRIPTION_SYNC_CORRECTED' } });
      if (expected.get(x.tenantId)) {
        expect(row).toMatchObject(CLEAN_SPARK);
        expect(rows).toBe(1);
      } else {
        expect(row.paystackSubscriptionCode).not.toBeNull();
        expect(rows).toBe(0);
      }
    }
  }, 60000);
});
