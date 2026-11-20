import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { prisma } from '../helpers/fixtures.js';
import { fakePaystack } from '../helpers/fake-paystack.js';
import { sendWebhook, sentWebhookKeys } from '../helpers/paystack-webhook.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { eventPassService } from '../../src/modules/event-pass/event-pass.service.js';
import { paymentReconciliationService } from '../../src/modules/payment-reconciliation/payment-reconciliation.service.js';
import { EVENT_PASS_PRICES_CENTS } from '../../src/modules/event-pass/event-pass-plans.config.js';
import {
  createPaymentsTenant,
  createSuperAdmin,
  cleanupPayments,
  headersFor,
  installAuth,
  paymentAlerts,
  trackedReferences,
  type PaymentsTenant,
} from './payments-fixtures.js';

// ─────────────────────────────────────────
//  THE WEBHOOK ITSELF AND RECONCILIATION (payments release 1): what nothing
//  handles is recorded and alerted; id-less deliveries never collide; a
//  database failure leaves the delivery unseen so Paystack's retry is
//  processed; the daily reconciliation finds what doesn't add up; the
//  super admin's routes show the ledger, mismatches and runs, to nobody
//  else.
// ─────────────────────────────────────────

const referenceOf = (url: string) => url.split('/').pop() as string;

let t: PaymentsTenant;

beforeEach(async () => {
  installAuth();
  clearSentEmails();
  t = await createPaymentsTenant();
}, 60000);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupPayments();
}, 120000);

const buyPass = async (passTier = 'SMALL') => {
  const res = await request(app).post(`/api/events/${t.eventId}/pass/purchase`).set(headersFor(t.admin)).send({ passTier });
  return referenceOf(res.body.data.authorizationUrl);
};

describe('the webhook', () => {
  it('an event nothing handles is recorded and alerted', async () => {
    const id = `unk_${Date.now()}`;
    const res = await sendWebhook('paymentrequest.success', { id, amount: 500, currency: 'ZAR' });
    expect(res.status).toBe(200);
    const row = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { paystackReference: id } });
    expect(row.type).toBe('WEBHOOK_EVENT_UNHANDLED');
    expect(paymentAlerts().some((e) => /nothing handled: paymentrequest\.success/.test(e.subject))).toBe(true);
  }, 60000);

  it('a charge for a reference nobody knows is unhandled and alerted too', async () => {
    const reference = `stranger_${Date.now()}`;
    trackedReferences.push(reference);
    await sendWebhook('charge.success', { id: Date.now(), reference, amount: 100, currency: 'ZAR', customer: { customer_code: 'CUS_nobody', email: 'nobody@x.test' } });
    expect((await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { paystackReference: { not: null }, payload: { path: ['data', 'reference'], equals: reference } } })).type).toBe('WEBHOOK_EVENT_UNHANDLED');
    expect(paymentAlerts()).toHaveLength(1);
  }, 60000);

  it('informational events are recorded quietly', async () => {
    const id = `inv_${Date.now()}`;
    await sendWebhook('invoice.create', { id, amount: 100, currency: 'ZAR' });
    expect((await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { paystackReference: id } })).type).toBe('WEBHOOK_EVENT_IGNORED');
    expect(paymentAlerts()).toHaveLength(0);
  }, 60000);

  it('two different deliveries with neither an id nor a reference are both handled', async () => {
    const before = await prisma.paymentLedgerEntry.count({ where: { type: 'WEBHOOK_EVENT_UNHANDLED', relatedId: 'customeridentification.weird' } });
    const a = await sendWebhook('customeridentification.weird', { note: `a-${Date.now()}` });
    const b = await sendWebhook('customeridentification.weird', { note: `b-${Date.now()}` });
    expect(a.body.outcome).toBe('processed');
    expect(b.body.outcome).toBe('processed');
    expect(sentWebhookKeys.at(-1)).not.toBe(sentWebhookKeys.at(-2));
    const after = await prisma.paymentLedgerEntry.count({ where: { type: 'WEBHOOK_EVENT_UNHANDLED', relatedId: 'customeridentification.weird' } });
    expect(after - before).toBe(2);
    await prisma.paymentLedgerEntry.deleteMany({ where: { relatedId: 'customeridentification.weird' } });
  }, 60000);

  it("a database failure while handling: 500, the delivery not marked seen, and Paystack's retry is processed", async () => {
    const reference = await buyPass();
    const data = fakePaystack.pay(reference);
    const spy = vi.spyOn(eventPassService, 'confirmPassPurchaseWithinTransaction').mockRejectedValueOnce(new Error('database unavailable'));
    const failed = await sendWebhook('charge.success', data);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toMatch(/database unavailable/);
    expect(await prisma.paystackWebhookEvent.count({ where: { dedupeKey: sentWebhookKeys.at(-1)! } })).toBe(0);
    spy.mockRestore();

    const retried = await sendWebhook('charge.success', data);
    expect(retried.body.outcome).toBe('processed');
    expect((await prisma.eventPass.findUnique({ where: { eventId: t.eventId } }))?.passTier).toBe('SMALL');
  }, 60000);

  it('concurrent deliveries of one success confirm it once', async () => {
    const reference = await buyPass();
    const data = fakePaystack.pay(reference);
    const results = await Promise.all([sendWebhook('charge.success', data), sendWebhook('charge.success', data), sendWebhook('charge.success', data)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.paymentLedgerEntry.count({ where: { paystackReference: reference, type: 'EVENT_PASS_PURCHASE_SUCCEEDED' } })).toBe(1);
  }, 60000);
});

describe('daily reconciliation', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('matches what agrees, and lists what Paystack has that the ledger lacks, amounts that differ, ledger-only successes and unrecorded refunds', async () => {
    // Agrees: a pass bought and confirmed.
    const ok = await buyPass('SMALL');
    await sendWebhook('charge.success', fakePaystack.pay(ok));

    // Paystack only: a success the app never heard of.
    const stranger = fakePaystack.addTransaction({ amount: 1234, email: 'x@y.test' });
    trackedReferences.push(stranger.reference);

    // Amounts differ: the ledger's success row says something else.
    const other = await createPaymentsTenant();
    const diffRes = await request(app).post(`/api/events/${other.eventId}/pass/purchase`).set(headersFor(other.admin)).send({ passTier: 'LARGE' });
    const diff = referenceOf(diffRes.body.data.authorizationUrl);
    await sendWebhook('charge.success', fakePaystack.pay(diff));
    await prisma.paymentLedgerEntry.updateMany({ where: { paystackReference: diff, type: 'EVENT_PASS_PURCHASE_SUCCEEDED' }, data: { amountCents: 1 } });

    // Ledger only: a success row Paystack can't confirm.
    const ghost = `ghost_${Date.now()}`;
    trackedReferences.push(ghost);
    await prisma.paymentLedgerEntry.create({ data: { type: 'SUBSCRIPTION_CHARGE_SUCCEEDED', amountCents: 29900, tenantId: t.tenantId, paystackReference: ghost } });

    // A refund Paystack processed that the ledger never recorded.
    fakePaystack.refunds.push({ id: 'rf_unseen', transaction_reference: ok, status: 'processed', amount: EVENT_PASS_PRICES_CENTS.SMALL, currency: 'ZAR' });

    const result = await paymentReconciliationService.reconcileDay(today, { tenantIds: [t.tenantId, other.tenantId] });
    const kinds = result.mismatches.map((m) => `${m.kind}:${m.paystackReference}`);
    expect(kinds).toContain(`PAYSTACK_ONLY:${stranger.reference}`);
    expect(kinds).toContain(`AMOUNT_DIFFERS:${diff}`);
    expect(kinds).toContain(`LEDGER_ONLY:${ghost}`);
    expect(kinds).toContain(`REFUND_NOT_RECORDED:${ok}`);
    expect(kinds.some((k) => k.endsWith(`:${ok}`) && !k.startsWith('REFUND'))).toBe(false);
  }, 60000);

  it('a run is claimed once per day, saves its mismatches against the run and sends one alert', async () => {
    const runDate = `2099-01-${String(new Date().getUTCMilliseconds() % 28 + 1).padStart(2, '0')}`;
    await prisma.paymentReconciliationRun.deleteMany({ where: { runDate } });
    const stranger = fakePaystack.addTransaction({ amount: 777, email: 'x@y.test', paidAt: `${runDate}T10:00:00.000Z` });
    trackedReferences.push(stranger.reference);

    const first = await paymentReconciliationService.runForDate(runDate, { tenantIds: [t.tenantId] });
    expect(first?.mismatches).toHaveLength(1);
    expect(await paymentReconciliationService.runForDate(runDate, { tenantIds: [t.tenantId] })).toBeNull();

    const run = await prisma.paymentReconciliationRun.findUniqueOrThrow({ where: { runDate }, include: { mismatches: true } });
    expect(run).toMatchObject({ status: 'DONE', mismatchCount: 1 });
    expect(run.mismatches[0]).toMatchObject({ kind: 'PAYSTACK_ONLY', paystackReference: stranger.reference });
    expect(paymentAlerts().filter((e) => /Reconciliation for/.test(e.subject))).toHaveLength(1);

    await prisma.paymentMismatch.deleteMany({ where: { runId: run.id } });
    await prisma.paymentReconciliationRun.delete({ where: { id: run.id } });
  }, 60000);
});

describe('super admin payment routes', () => {
  it('the super admin sees the ledger, mismatches and runs; a tenant admin gets the global 404', async () => {
    const reference = await buyPass('SMALL');
    await sendWebhook('charge.success', fakePaystack.pay(reference, { amount: 1 }));
    const admin = await createSuperAdmin();

    const ledger = await request(app).get(`/api/admin/payments/ledger?reference=${reference}`).set(headersFor(admin));
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.items.map((i: { type: string }) => i.type)).toEqual(
      expect.arrayContaining(['EVENT_PASS_PURCHASE_INITIATED', 'PAYMENT_AMOUNT_MISMATCH'])
    );

    const mismatches = await request(app).get('/api/admin/payments/mismatches?status=open&limit=200').set(headersFor(admin));
    expect(mismatches.status).toBe(200);
    expect(mismatches.body.data.items.some((m: { paystackReference: string }) => m.paystackReference === reference)).toBe(true);

    expect((await request(app).get('/api/admin/payments/reconciliation-runs').set(headersFor(admin))).status).toBe(200);
    expect((await request(app).get('/api/admin/payments/ledger?type=NOT_A_TYPE').set(headersFor(admin))).status).toBe(422);

    for (const path of ['/ledger', '/mismatches', '/reconciliation-runs']) {
      const res = await request(app).get(`/api/admin/payments${path}`).set(headersFor(t.admin));
      expect(res.status).toBe(404);
    }
  }, 60000);
});
