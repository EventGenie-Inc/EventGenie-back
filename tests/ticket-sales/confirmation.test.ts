import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { installFirebaseMock } from '../helpers/team.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { mockResendSend } from '../setup.js';
import { ticketOrderWorker } from '../../src/modules/ticket-order/ticket-order.worker.js';
import { verifyPassPayload } from '../../src/modules/check-in-pass/check-in-pass-token.util.js';
import { pdfPagesOf } from '../helpers/pdf.js';
import { cleanupTicketSalesFixtures } from './helpers.js';
import { checkout, orderStatus, pay, latestReference, referencesOf, sellingEvent, buyAndPay, fakePaystack, sendWebhook, prisma } from './orders-helpers.js';

// ─────────────────────────────────────────
//  CONFIRMATION (ticket sales Round B)
//
//  charge.success (the signed webhook) and the order status page's verify
//  confirm an order once, in one transaction: amounts, currency, subaccount
//  and split checked against the snapshot; tickets issued one per unit; the
//  ledger with Paystack's actual fee. A late success after the hold ran out
//  is still honoured (an oversell flagged); a second success is a
//  PAYMENT_DUPLICATE; a retry keeps every earlier reference.
// ─────────────────────────────────────────

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTicketSalesFixtures();
});

const orderOf = (id: string) => prisma.ticketOrder.findUniqueOrThrow({ where: { id }, include: { tickets: true, payments: true } });
const ledgerOf = (orderId: string) => prisma.paymentLedgerEntry.findMany({ where: { relatedId: orderId }, orderBy: { createdAt: 'asc' } });

describe('a correct payment', () => {
  it('issues one ticket per unit, sold from the hold, once, however often the webhook comes', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 2 }, { ticketTypeId: s.saturday, quantity: 1 }]);
    const orderId = res.body.data.orderId;
    const reference = await latestReference(orderId);
    const data = fakePaystack.pay(reference);
    expect((await sendWebhook('charge.success', data)).status).toBe(200);
    // A redelivery (the same bytes), and a different delivery of the same event.
    await sendWebhook('charge.success', data);
    await sendWebhook('charge.success', { ...data, gateway_response: 'Approved again' });

    const order = await orderOf(orderId);
    expect(order).toMatchObject({ status: 'PAID', paidReference: reference, oversold: false });
    expect(order.tickets).toHaveLength(3);
    expect(order.tickets.map((t) => t.indexInOrder).sort()).toEqual([1, 2, 3]);
    for (const t of order.tickets) expect(t.number).toMatch(/^TK-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const types = await prisma.ticket.findMany({ where: { id: { in: [s.general, s.saturday] } } });
    expect(types.find((t) => t.id === s.general)).toMatchObject({ soldCount: 2, heldCount: 0 });
    expect(types.find((t) => t.id === s.saturday)).toMatchObject({ soldCount: 1, heldCount: 0 });
    expect((await ledgerOf(orderId)).filter((e) => e.type === 'TICKET_PAYMENT_SUCCEEDED')).toHaveLength(1);

    // The buyer's page now has them, each with its own QR payload.
    const view = await orderStatus(res.body.data.orderToken);
    expect(view.body.data.status).toBe('PAID');
    expect(view.body.data.tickets).toHaveLength(3);
    for (const t of view.body.data.tickets) expect(verifyPassPayload(t.payload)).toEqual({ kind: 'TICKET', passId: t.id });
    expect(view.body.data.tickets.map((t: { label: string }) => t.label)).toEqual(['Ticket 1 of 3', 'Ticket 2 of 3', 'Ticket 3 of 3']);
  }, 60000);

  it('the webhook and the verify arriving together confirm it once', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 2 }]);
    const reference = await latestReference(res.body.data.orderId);
    const data = fakePaystack.pay(reference);
    await Promise.all([sendWebhook('charge.success', data), orderStatus(res.body.data.orderToken, true), orderStatus(res.body.data.orderToken, true)]);
    const order = await orderOf(res.body.data.orderId);
    expect(order.status).toBe('PAID');
    expect(order.tickets).toHaveLength(2);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).soldCount).toBe(2);
  }, 60000);

  it('never "paid" before Paystack confirms; a refresh before paying records the abandoned attempt, and a later success still lands', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    // No refresh: PENDING, with where to pay.
    const pending = (await orderStatus(res.body.data.orderToken)).body.data;
    expect(pending).toMatchObject({ status: 'PENDING', tickets: [], authorizationUrl: res.body.data.authorizationUrl });
    // A refresh asks Paystack, which calls an unpaid checkout abandoned (as
    // the Event Pass reconcile records it): FAILED, never PAID, hold freed.
    expect((await orderStatus(res.body.data.orderToken, true)).body.data).toMatchObject({ status: 'FAILED', tickets: [] });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).heldCount).toBe(0);
    // Paid after all: honoured.
    await pay(await latestReference(res.body.data.orderId));
    expect((await orderStatus(res.body.data.orderToken)).body.data.status).toBe('PAID');
  }, 60000);
});

describe('a payment that doesn\'t match its order', () => {
  const cases: [string, (total: number, subtotal: number) => Parameters<typeof fakePaystack.pay>[1]][] = [
    ['the amount', (total) => ({ amount: total - 100 })],
    ['the currency', () => ({ currency: 'NGN' })],
    ['the subaccount', () => ({ subaccount: 'ACCT_someone_else' })],
    ['the split', () => ({ transactionCharge: 1 })],
  ];
  it.each(cases)('%s wrong: UNDER_REVIEW, alerted, no tickets, its stock freed', async (_what, spoil) => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 2 }]);
    const orderId = res.body.data.orderId;
    await pay(await latestReference(orderId), spoil(res.body.data.amounts.totalCents, res.body.data.amounts.subtotalCents));
    const order = await orderOf(orderId);
    expect(order).toMatchObject({ status: 'UNDER_REVIEW', reviewReason: 'PAYMENT_MISMATCH' });
    expect(order.tickets).toHaveLength(0);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).toMatchObject({ soldCount: 0, heldCount: 0 });
    expect((await ledgerOf(orderId)).map((e) => e.type)).toContain('PAYMENT_AMOUNT_MISMATCH');
    expect(await prisma.paymentMismatch.count({ where: { eventId: s.ev.eventId } })).toBe(1);
    expect(sentEmails().some((e) => e.to === 'admin@e-velope.co.za')).toBe(true);
    expect((await orderStatus(res.body.data.orderToken)).body.data.tickets).toEqual([]);
  }, 60000);
});

describe('late, twice, and retried', () => {
  it('a success after the hold expired still issues tickets, and flags an oversell to the organisation and the super admin', async () => {
    const s = await sellingEvent({ saturdayQuantity: 1 });
    const late = await checkout(s, [{ ticketTypeId: s.saturday, quantity: 1 }]);
    await ticketOrderWorker.runOnce({ now: new Date(Date.now() + 31 * 60_000), eventIds: [s.ev.eventId] });
    expect((await orderOf(late.body.data.orderId)).status).toBe('EXPIRED');
    // Someone else buys the last one meanwhile.
    await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]);
    clearSentEmails();

    await pay(await latestReference(late.body.data.orderId));
    const order = await orderOf(late.body.data.orderId);
    expect(order).toMatchObject({ status: 'PAID', oversold: true });
    expect(order.tickets).toHaveLength(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.saturday } })).soldCount).toBe(2);
    const subjects = sentEmails().map((e) => [e.to, e.subject]);
    expect(subjects).toContainEqual([s.org.admin.email, expect.stringMatching(/More tickets sold than available/)]);
    expect(subjects).toContainEqual(['admin@e-velope.co.za', expect.stringMatching(/More tickets sold than available/)]);
  }, 60000);

  it('a second success on the order: PAYMENT_DUPLICATE for the super admin, no extra tickets', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const orderId = res.body.data.orderId;
    const first = await latestReference(orderId);
    fakePaystack.fail(first);
    await sendWebhook('charge.failed', fakePaystack.webhookDataFor(first));
    expect((await orderOf(orderId)).status).toBe('FAILED');
    // The buyer tries again: a second reference.
    const retried = await (await import('supertest')).default((await import('../../src/app.js')).default)
      .post('/api/ticket-orders/retry')
      .send({ token: res.body.data.orderToken });
    expect(retried.status).toBe(201);
    const second = await latestReference(orderId);
    await pay(second);
    // ...and the first, abandoned, is paid after all, in another tab.
    await pay(first);

    const order = await orderOf(orderId);
    expect(order.status).toBe('PAID');
    expect(order.paidReference).toBe(second);
    expect(order.tickets).toHaveLength(1);
    expect(order.payments.find((p) => p.reference === first)?.status).toBe('DUPLICATE');
    expect((await ledgerOf(orderId)).map((e) => e.type)).toContain('PAYMENT_DUPLICATE');
    expect(await prisma.paymentMismatch.count({ where: { paystackReference: first, kind: 'DUPLICATE_PAYMENT' } })).toBe(1);
  }, 60000);

  it('a retry keeps every earlier reference, and a late success on an old one is honoured', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 2 }]);
    const orderId = res.body.data.orderId;
    const first = await latestReference(orderId);
    await ticketOrderWorker.runOnce({ now: new Date(Date.now() + 31 * 60_000), eventIds: [s.ev.eventId] });
    const request = (await import('supertest')).default;
    const app = (await import('../../src/app.js')).default;
    expect((await request(app).post('/api/ticket-orders/retry').send({ token: res.body.data.orderToken })).status).toBe(201);
    const refs = await referencesOf(orderId);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(first);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).heldCount).toBe(2);

    // The old reference is the one paid.
    await pay(first);
    const order = await orderOf(orderId);
    expect(order).toMatchObject({ status: 'PAID', paidReference: first });
    expect(order.tickets).toHaveLength(2);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).toMatchObject({ soldCount: 2, heldCount: 0 });
  }, 60000);
});

describe('the ledger', () => {
  it("records Paystack's actual fee and its difference from the calculated one", async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const orderId = res.body.data.orderId;
    await pay(await latestReference(orderId), { fees: 820 });
    const success = (await ledgerOf(orderId)).find((e) => e.type === 'TICKET_PAYMENT_SUCCEEDED')!;
    expect(success.amountCents).toBe(21_224);
    expect(success.payload).toMatchObject({ actualFeeCents: 820, calculatedProcessingFeeCents: 824, feeDifferenceCents: -4, netCents: 1224 - 400 - 820 });
    expect((await ledgerOf(orderId)).find((e) => e.type === 'COMMISSION_TAKEN')?.amountCents).toBe(400);
    expect((await orderOf(orderId)).actualFeeCents).toBe(820);
    expect(await prisma.paymentMismatch.count({ where: { eventId: s.ev.eventId, kind: 'NEGATIVE_NET' } })).toBe(0);
  }, 60000);

  // Paystack's international card rate (3.1% + R1, then 15% VAT, each part
  // rounded up) on a R200 ticket's R212.24 total: ⌈657.944⌉ = 658, + 100 =
  // 758, + ⌈113.7⌉ = 114: R8.72, against the R8.24 the local rate assumed.
  const INTERNATIONAL_FEE_ON_R200 = 872;

  it('an international-rate fee on a R200 ticket records the difference, with no alert (e-velope still earns R3.52)', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const orderId = res.body.data.orderId;
    clearSentEmails();
    await pay(await latestReference(orderId), { fees: INTERNATIONAL_FEE_ON_R200 });
    const success = (await ledgerOf(orderId)).find((e) => e.type === 'TICKET_PAYMENT_SUCCEEDED')!;
    expect(success.payload).toMatchObject({ actualFeeCents: 872, calculatedProcessingFeeCents: 824, feeDifferenceCents: 48, transactionChargeCents: 1224 });
    // What e-velope keeps of its R12.24 charge: R3.52 instead of the R4.00 commission.
    expect(1224 - 872).toBe(352);
    expect(await prisma.paymentMismatch.count({ where: { eventId: s.ev.eventId, kind: 'NEGATIVE_NET' } })).toBe(0);
    expect(sentEmails().some((e) => /fee was more than we charged/.test(e.subject))).toBe(false);
    expect((await orderOf(orderId)).status).toBe('PAID');
  }, 60000);

  it("a fee above e-velope's whole charge (a real loss) raises the alert", async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const orderId = res.body.data.orderId;
    clearSentEmails();
    await pay(await latestReference(orderId), { fees: 1300 });
    const mismatches = await prisma.paymentMismatch.findMany({ where: { eventId: s.ev.eventId, kind: 'NEGATIVE_NET' } });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ expectedAmountCents: 1224, actualAmountCents: 1300, details: { lossCents: 76 } });
    expect(sentEmails().some((e) => e.to === 'admin@e-velope.co.za' && /fee was more than we charged/.test(e.subject))).toBe(true);
    // The order is still paid: the buyer did nothing wrong.
    expect((await orderOf(orderId)).status).toBe('PAID');
  }, 60000);
});

describe('the daily reconciliation', () => {
  it('matches ticket orders against Paystack, and finds a real loss (not an international fee) from its listed fee', async () => {
    const { paymentReconciliationService } = await import('../../src/modules/payment-reconciliation/payment-reconciliation.service.js');
    const s = await sellingEvent();
    const fine = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const fineRef = await latestReference(fine.body.data.orderId);
    await pay(fineRef);
    const international = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const internationalRef = await latestReference(international.body.data.orderId);
    await pay(internationalRef, { fees: 950 });
    const loss = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const lossRef = await latestReference(loss.body.data.orderId);
    await pay(lossRef, { fees: 1300 });

    const today = new Date().toISOString().slice(0, 10);
    const result = await paymentReconciliationService.reconcileDay(today, { tenantIds: [s.org.tenantId] });
    const forRef = (ref: string) => result.mismatches.filter((m) => m.paystackReference === ref).map((m) => m.kind);
    expect(forRef(fineRef)).toEqual([]);
    expect(forRef(internationalRef)).toEqual([]);
    expect(forRef(lossRef)).toEqual(['NEGATIVE_NET']);
  }, 60000);

  it("the day's summary totals the fee differences (actual less calculated) for the super admin", async () => {
    const { paymentReconciliationService } = await import('../../src/modules/payment-reconciliation/payment-reconciliation.service.js');
    const s = await sellingEvent();
    for (const fees of [872, 820, 1300]) {
      const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
      await pay(await latestReference(res.body.data.orderId), { fees });
    }
    const today = new Date().toISOString().slice(0, 10);
    const result = await paymentReconciliationService.reconcileDay(today, { tenantIds: [s.org.tenantId] });
    // 872 − 824 = 48, 820 − 824 = −4, 1300 − 824 = 476.
    expect(result).toMatchObject({ ticketFeeDifferenceTotalCents: 48 - 4 + 476, ticketFeeDifferenceCount: 3 });
  }, 60000);
});

describe("the buyer's email and PDF", () => {
  it('one email with a PDF: a page per ticket, each QR decoding to that ticket\'s payload; a link to the order with the token in the fragment', async () => {
    const s = await sellingEvent();
    const { orderId, token, tickets } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 2 }, { ticketTypeId: s.saturday, quantity: 1 }]);
    const order = await orderOf(orderId);
    expect(order.confirmationEmailSentAt).not.toBeNull();

    const calls = mockResendSend.mock.calls.filter((c) => (c[0] as { to: string }).to === order.buyerEmail);
    expect(calls).toHaveLength(1);
    const [email, options] = calls[0]! as [{ subject: string; html: string; attachments: { filename: string; contentType: string; content: string }[] }, { idempotencyKey: string }];
    expect(email.subject).toMatch(/^Your tickets for /);
    expect(options).toEqual({ idempotencyKey: `ticket-order/${orderId}` });
    for (const t of tickets) expect(email.html).toContain(t.number);
    const link = email.html.match(/href="([^"]*\/tickets\/order[^"]*)"/)![1]!.replace(/&amp;/g, '&');
    const url = new URL(link);
    expect(url.pathname).toBe('/tickets/order');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#token=${token}`);

    const pdf = email.attachments.find((a) => a.contentType === 'application/pdf')!;
    expect(pdf.filename).toBe('tickets.pdf');
    // Each page: its QR (decoded as a phone would), then the e-velope logo
    // (the email lockup, 400x90) where "Sent with e-velope" used to be.
    const pages = await pdfPagesOf(Buffer.from(pdf.content, 'base64'));
    expect(pages).toHaveLength(3);
    const view = (await orderStatus(token)).body.data.tickets as { payload: string }[];
    expect(pages.map((p) => p.images[0]?.qr)).toEqual(view.map((t) => t.payload));
    for (const p of pages) expect(p.images.map((i) => [i.pixelWidth, i.pixelHeight]).slice(1)).toEqual([[400, 90]]);

    // The worker finds nothing left to send: once only.
    expect(await ticketOrderWorker.runOnce({ eventIds: [s.ev.eventId] })).toMatchObject({ emailed: 0 });
  }, 60000);

  it('a failed send is sent by the worker later, once', async () => {
    const s = await sellingEvent();
    mockResendSend.mockResolvedValueOnce({ data: null, error: { message: 'down', name: 'application_error', statusCode: 500 } });
    const { orderId } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    expect((await orderOf(orderId)).confirmationEmailSentAt).toBeNull();
    expect(await ticketOrderWorker.runOnce({ eventIds: [s.ev.eventId] })).toMatchObject({ emailed: 1 });
    expect((await orderOf(orderId)).confirmationEmailSentAt).not.toBeNull();
    expect(await ticketOrderWorker.runOnce({ eventIds: [s.ev.eventId] })).toMatchObject({ emailed: 0 });
  }, 60000);
});
