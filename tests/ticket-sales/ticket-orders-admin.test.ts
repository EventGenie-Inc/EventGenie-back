import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock, assign, createActor } from '../helpers/team.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { scrubText, scrubValue } from '../../src/shared/monitoring/sentry-scrub.js';
import { buildPassPayload } from '../../src/modules/check-in-pass/check-in-pass-token.util.js';
import { cleanupTicketSalesFixtures, createTicketedEvent } from './helpers.js';
import { buyAndPay, checkout, sellingEvent, orderStatus, sendWebhook, fakePaystack, prisma, type Selling } from './orders-helpers.js';

// ─────────────────────────────────────────
//  CANCELLING, REFUNDS AND CHARGEBACKS, THE SALES VIEW (ticket sales Round B)
// ─────────────────────────────────────────

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTicketSalesFixtures();
});

const cancel = (s: Selling, orderId: string, body: Record<string, unknown>, actor = s.org.admin) =>
  request(app).post(`/api/events/${s.ev.eventId}/ticket-sales/orders/${orderId}/cancel`).set(headersFor(actor)).send(body);

describe('the organiser cancels tickets', () => {
  it('frees the place, voids the QR, emails the buyer and audits; no Paystack call; the checked-in one is said so', async () => {
    const s = await sellingEvent({ saturdayQuantity: 2 });
    const { orderId, tickets } = await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 2 }]);
    // One of them was checked in already.
    await request(app).post(`/api/events/${s.ev.eventId}/check-in/scan`).set(headersFor(s.org.admin)).send({ eventDayId: s.ev.dayIds[1], payload: buildPassPayload({ id: tickets[0]!.id, kind: 'TICKET' }) });
    const paystackCalls = fakePaystack.calls.length;
    clearSentEmails();

    expect((await cancel(s, orderId, { reason: ' ' })).body.code).toBe('TICKET_CANCEL_REASON_REQUIRED');
    const res = await cancel(s, orderId, { reason: 'The venue changed its capacity', ticketIds: [tickets[0]!.id] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderId, emailSent: true, cancelled: [{ ticketId: tickets[0]!.id, number: tickets[0]!.number, wasCheckedIn: true }] });

    expect(await prisma.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0]!.id } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'The venue changed its capacity', cancelledByUserId: s.org.admin.id });
    expect((await prisma.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1]!.id } })).status).toBe('VALID');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.saturday } })).soldCount).toBe(1);
    // The freed place can be bought again.
    expect((await checkout(s, [{ ticketTypeId: s.saturday, quantity: 1 }])).status).toBe(201);

    const email = sentEmails().find((e) => /cancelled/.test(e.subject))!;
    expect(email.html).toContain(tickets[0]!.number);
    expect(email.html).not.toContain(tickets[1]!.number);
    expect(email.text).toMatch(/The venue changed its capacity/);
    expect(email.text).toMatch(/refund is handled by the organiser/);
    const audit = await prisma.adminAuditEntry.findFirstOrThrow({ where: { tenantId: s.org.tenantId, action: 'TICKETS_CANCELLED' } });
    expect(audit.details).toMatchObject({ orderId, reason: 'The venue changed its capacity' });
    expect(fakePaystack.calls.slice(paystackCalls).filter((c) => c.path.includes('refund'))).toHaveLength(0);
    expect(fakePaystack.calls.length).toBe(paystackCalls + 1); // only the new checkout's initialize

    // It can't be undone, and a cancelled ticket can't be cancelled again.
    expect((await cancel(s, orderId, { reason: 'Again', ticketIds: [tickets[0]!.id] })).status).toBe(409);
  }, 60000);
});

describe('refunds and chargebacks (the webhooks)', () => {
  const paidOrder = async (s: Selling, quantity = 2) => {
    const bought = await buyAndPay(s, [{ ticketTypeId: s.general, quantity }]);
    const order = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: bought.orderId } });
    return { ...bought, order };
  };
  let nextId = 9_200_000 + Math.floor(Math.random() * 100_000);

  it('a full refund voids every ticket and frees the places; the organisation is told', async () => {
    const s = await sellingEvent();
    const { order } = await paidOrder(s);
    clearSentEmails();
    await sendWebhook('refund.processed', { id: ++nextId, transaction_reference: order.paidReference, amount: order.totalCents, currency: 'ZAR', status: 'processed' });
    expect((await prisma.ticketOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('REFUNDED');
    expect((await prisma.issuedTicket.findMany({ where: { orderId: order.id } })).map((t) => t.status)).toEqual(['REFUNDED', 'REFUNDED']);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).soldCount).toBe(0);
    const refund = await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { relatedId: order.id, type: 'REFUND_ISSUED' } });
    expect(refund.payload).toMatchObject({ full: true, effect: 'TICKETS_VOIDED', voided: 2 });
    expect(sentEmails().some((e) => e.to === s.org.admin.email && /refunded/i.test(e.subject))).toBe(true);
  }, 60000);

  it('a partial refund voids nothing: flagged for the super admin, the organisation told', async () => {
    const s = await sellingEvent();
    const { order } = await paidOrder(s);
    clearSentEmails();
    await sendWebhook('refund.processed', { id: ++nextId, transaction_reference: order.paidReference, amount: 5_000, currency: 'ZAR', status: 'processed' });
    expect((await prisma.ticketOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
    expect((await prisma.issuedTicket.findMany({ where: { orderId: order.id } })).every((t) => t.status === 'VALID')).toBe(true);
    expect((await prisma.paymentLedgerEntry.findFirstOrThrow({ where: { relatedId: order.id, type: 'REFUND_ISSUED' } })).payload).toMatchObject({ full: false, effect: 'PARTIAL_RECORDED_ONLY' });
    expect(sentEmails().some((e) => e.to === 'admin@e-velope.co.za' && /needs a decision/.test(e.subject))).toBe(true);
    expect(sentEmails().some((e) => e.to === s.org.admin.email && /Part of a ticket order refunded/.test(e.subject))).toBe(true);
  }, 60000);

  it('a chargeback opened: UNDER_REVIEW, the tickets still admit; won: back to PAID', async () => {
    const s = await sellingEvent();
    const { order, tickets } = await paidOrder(s, 1);
    clearSentEmails();
    await sendWebhook('charge.dispute.create', { id: ++nextId, transaction: { reference: order.paidReference }, amount: order.totalCents, currency: 'ZAR', status: 'awaiting-merchant-feedback' });
    expect(await prisma.ticketOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'UNDER_REVIEW', reviewReason: 'DISPUTE', disputeStatus: 'OPEN' });
    const scan = await request(app).post(`/api/events/${s.ev.eventId}/check-in/scan`).set(headersFor(s.org.admin)).send({ eventDayId: s.ev.dayIds[0], payload: buildPassPayload({ id: tickets[0]!.id, kind: 'TICKET' }) });
    expect(scan.body.data.result).toBe('GREEN');
    expect(sentEmails().some((e) => e.to === s.org.admin.email && /chargeback/i.test(e.subject))).toBe(true);
    expect(sentEmails().some((e) => e.to === 'admin@e-velope.co.za' && /Chargeback opened/.test(e.subject))).toBe(true);

    await sendWebhook('charge.dispute.resolve', { id: ++nextId, transaction: { reference: order.paidReference }, amount: order.totalCents, currency: 'ZAR', resolution: 'declined' });
    expect(await prisma.ticketOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'PAID', reviewReason: null, disputeStatus: 'WON' });
  }, 60000);

  it('a chargeback lost: treated as a full refund (REVERSED)', async () => {
    const s = await sellingEvent();
    const { order } = await paidOrder(s);
    await sendWebhook('charge.dispute.create', { id: ++nextId, transaction: { reference: order.paidReference }, amount: order.totalCents, currency: 'ZAR' });
    await sendWebhook('charge.dispute.resolve', { id: ++nextId, transaction: { reference: order.paidReference }, amount: order.totalCents, currency: 'ZAR', resolution: 'merchant-accepted' });
    expect(await prisma.ticketOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'REVERSED', disputeStatus: 'LOST' });
    expect((await prisma.issuedTicket.findMany({ where: { orderId: order.id } })).every((t) => t.status === 'REVERSED')).toBe(true);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).soldCount).toBe(0);
  }, 60000);
});

describe('the sales view', () => {
  it('per type sold, remaining and revenue (the subtotal only); the orders with buyers; for the event\'s admins only', async () => {
    const s = await sellingEvent();
    const { orderId, tickets } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 2 }]);
    const h = headersFor(s.org.admin);
    const summary = (await request(app).get(`/api/events/${s.ev.eventId}/ticket-sales/summary`).set(h)).body.data;
    expect(summary.types.find((t: { ticketTypeId: string }) => t.ticketTypeId === s.general)).toMatchObject({ sold: 2, remaining: 98, revenueCents: 40_000 });
    expect(summary.totals).toEqual({ sold: 2, revenueCents: 40_000 });

    const orders = (await request(app).get(`/api/events/${s.ev.eventId}/ticket-sales/orders`).set(h)).body.data;
    expect(orders.total).toBe(1);
    expect(orders.items[0]).toMatchObject({
      id: orderId,
      status: 'PAID',
      buyer: { name: 'Thandi Nkosi', phone: '+27821234567' },
      amounts: { subtotalCents: 40_000 },
      tickets: [{ id: tickets[0]!.id, number: tickets[0]!.number, status: 'VALID', checkIns: [] }, { id: tickets[1]!.id }],
    });
    expect(orders.items[0].buyer.email).toMatch(/@test\.invalid$/);

    // A locked member not assigned to this event: refused (404), and nobody
    // signed out or of another organisation sees anything.
    const other = await createTicketedEvent(s.org);
    await assign(s.org.tenantId, s.org.eventAdmin.id, other.eventId, s.org.admin.id);
    for (const path of ['summary', 'orders']) {
      expect((await request(app).get(`/api/events/${s.ev.eventId}/ticket-sales/${path}`).set(headersFor(s.org.eventAdmin))).status).toBe(404);
      expect((await request(app).get(`/api/events/${s.ev.eventId}/ticket-sales/${path}`)).status).toBe(401);
    }
    expect((await cancel(s, orderId, { reason: 'x' }, s.org.eventAdmin)).status).toBe(404);
    const stranger = await createActor('TENANT_ADMIN', (await prisma.tenant.create({ data: { name: 'Other', slug: `o-${Date.now()}`, email: `o-${Date.now()}@test.invalid` } })).id);
    expect((await request(app).get(`/api/events/${s.ev.eventId}/ticket-sales/orders`).set(headersFor(stranger))).status).toBe(404);
    await prisma.user.delete({ where: { id: stranger.id } });
    await prisma.tenant.delete({ where: { id: stranger.tenantId! } });
    // Once assigned, the member sees it.
    await assign(s.org.tenantId, s.org.eventAdmin.id, s.ev.eventId, s.org.admin.id);
    expect((await request(app).get(`/api/events/${s.ev.eventId}/ticket-sales/orders`).set(headersFor(s.org.eventAdmin))).status).toBe(200);
  }, 60000);
});

describe('the retired invitation purchase path', () => {
  it('every old endpoint answers 410 TICKET_PURCHASE_RETIRED', async () => {
    for (const res of [
      await request(app).post('/api/rsvp/ticket-quote').send({ token: 'x', ticketId: 'y', quantity: 1 }),
      await request(app).post('/api/rsvp/ticket-purchase/retry').send({ token: 'x' }),
      await request(app).get('/api/rsvp/ticket-purchase/confirm/some-token'),
    ]) {
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('TICKET_PURCHASE_RETIRED');
    }
  }, 60000);
});

describe('tokens and payloads stay secret', () => {
  it('never in logs, URL paths or Sentry', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' '));
      });
    }
    const s = await sellingEvent();
    const { orderId, token, tickets } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const payload = buildPassPayload({ id: tickets[0]!.id, kind: 'TICKET' });
    await orderStatus(token, true);
    await request(app).post('/api/ticket-orders/status').send({ token: `${token}x` });
    await request(app).post(`/api/events/${s.ev.eventId}/check-in/scan`).set(headersFor(s.org.admin)).send({ eventDayId: s.ev.dayIds[0], payload });

    const all = logged.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(payload);
    // Never in a URL path: Paystack's callback and every link we make.
    for (const call of fakePaystack.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
    }
    const order = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: orderId } });
    const email = sentEmails().find((e) => e.to === order.buyerEmail)!;
    for (const href of [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!.replace(/&amp;/g, '&')))) {
      expect(href.pathname).not.toContain(token);
      expect(href.search).not.toContain(token);
    }
    // Sentry: in text, and by key.
    expect(scrubText(`order ${token} for ${payload}`)).not.toMatch(new RegExp(`${token.split('.')[1]}|${payload.split('.')[2]}`));
    expect(scrubText(payload)).toBe('[checkin-code]');
    expect(scrubText(token)).toBe('[order-token]');
    expect(JSON.stringify(scrubValue({ token, orderToken: token, payload }))).not.toContain(token.split('.')[1]);
  }, 60000);
});
