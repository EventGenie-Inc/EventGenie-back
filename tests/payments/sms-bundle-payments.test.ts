import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { prisma, createTestGuestWithInvite, deleteTestGuest } from '../helpers/fixtures.js';
import { fakePaystack } from '../helpers/fake-paystack.js';
import { sendWebhook } from '../helpers/paystack-webhook.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { SMS_BUNDLE_UNIT_PRICE_CENTS } from '../../src/modules/event-pass/event-pass-plans.config.js';
import { createPaymentsTenant, cleanupPayments, headersFor, installAuth, type PaymentsTenant } from './payments-fixtures.js';

// ─────────────────────────────────────────
//  SMS BUNDLE PAYMENTS (payments release 1): the same guarantees as an
//  Event Pass — confirmed only by Paystack, amount checked, FAILED → PAID,
//  one pending checkout reused, refunds taking back the remaining credits.
// ─────────────────────────────────────────

const buy = (t: PaymentsTenant, smsCount: unknown) =>
  request(app).post(`/api/events/${t.eventId}/pass/sms-bundle/purchase`).set(headersFor(t.admin)).send({ smsCount });
const referenceOf = (url: string) => url.split('/').pop() as string;
const bundleOf = (paymentRef: string) => prisma.eventSmsBundlePurchase.findFirstOrThrow({ where: { paymentRef } });
const balance = async (t: PaymentsTenant) =>
  (await request(app).get(`/api/events/${t.eventId}/pass/sms-bundle`).set(headersFor(t.admin))).body.data;

let t: PaymentsTenant;

beforeEach(async () => {
  installAuth();
  clearSentEmails();
  t = await createPaymentsTenant();
  // Bundles need an active pass on the event.
  await prisma.eventPass.create({ data: { eventId: t.eventId, tenantId: t.tenantId, passTier: 'STANDARD' } });
}, 60000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPayments();
}, 120000);

describe('SMS bundles', () => {
  it('paid through the webhook: credits added, amount checked, transaction id kept', async () => {
    const res = await buy(t, 100);
    expect(res.status).toBe(200);
    const reference = referenceOf(res.body.data.authorizationUrl);
    expect((await balance(t)).purchasedTotal).toBe(0);

    const data = fakePaystack.pay(reference);
    expect(data['amount']).toBe(100 * SMS_BUNDLE_UNIT_PRICE_CENTS);
    await sendWebhook('charge.success', data);
    expect((await balance(t)).remaining).toBe(100);
    expect((await bundleOf(reference)).paystackTransactionId).toBe(String(data['id']));
  }, 60000);

  it('the wrong amount grants no credits', async () => {
    const reference = referenceOf((await buy(t, 100)).body.data.authorizationUrl);
    await sendWebhook('charge.success', fakePaystack.pay(reference, { amount: 222 }));
    expect((await bundleOf(reference)).status).toBe('UNDER_REVIEW');
    expect((await balance(t)).remaining).toBe(0);
  }, 60000);

  it('FAILED then paid on the same checkout: credits added', async () => {
    const reference = referenceOf((await buy(t, 10)).body.data.authorizationUrl);
    await sendWebhook('charge.failed', fakePaystack.fail(reference));
    await sendWebhook('charge.success', fakePaystack.pay(reference));
    expect((await balance(t)).remaining).toBe(10);
  }, 60000);

  it('the same count again reuses the checkout; another count is 409', async () => {
    const first = await buy(t, 50);
    const again = await buy(t, 50);
    expect(again.body.data).toMatchObject({ authorizationUrl: first.body.data.authorizationUrl, reused: true });
    const other = await buy(t, 60);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('PAYMENT_ALREADY_PENDING');
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(1);
  }, 60000);

  it('a refund removes what was left of its credits; credits already sent stay sent', async () => {
    const reference = referenceOf((await buy(t, 100)).body.data.authorizationUrl);
    await sendWebhook('charge.success', fakePaystack.pay(reference));
    // 30 of the 100 were sent.
    const { guest, invite } = await createTestGuestWithInvite(t.eventId, t.admin.id, []);
    await prisma.smsSendLog.createMany({
      data: Array.from({ length: 30 }, () => ({ tenantId: t.tenantId, inviteId: invite.id, eventId: t.eventId, source: 'BUNDLE' as const })),
    });
    expect((await balance(t)).remaining).toBe(70);

    await sendWebhook('refund.processed', { id: 'rf_sms', transaction_reference: reference, amount: 100 * SMS_BUNDLE_UNIT_PRICE_CENTS, currency: 'ZAR' });
    expect((await bundleOf(reference)).status).toBe('REFUNDED');
    expect((await balance(t)).remaining).toBe(0);
    const refund = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { paystackReference: reference, type: 'REFUND_ISSUED' } });
    expect(refund.payload).toMatchObject({ product: 'SMS_BUNDLE', effect: 'SMS_CREDITS_REMOVED', creditsRemoved: 70 });
    await prisma.smsSendLog.deleteMany({ where: { eventId: t.eventId } });
    await deleteTestGuest(guest.id);
  }, 60000);

  it('a bad count is 422 before Paystack is called', async () => {
    for (const bad of [0, 5001, 1.5, '10']) expect((await buy(t, bad)).status).toBe(422);
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(0);
  }, 60000);
});
