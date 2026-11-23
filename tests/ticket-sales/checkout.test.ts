import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { installFirebaseMock } from '../helpers/team.js';
import { parseSaLocal } from '../../src/modules/reminder-schedule/reminder-schedule-time.util.js';
import { ticketOrderService } from '../../src/modules/ticket-order/ticket-order.service.js';
import { TERMS_VERSION } from '../../src/modules/terms/terms.service.js';
import { calculateTicketOrderFees } from '../../src/modules/ticket-sales/ticket-fee-calculator.js';
import { cleanupTicketSalesFixtures, createOrg, createTicketedEvent, createType, givePayoutAccount, setSales } from './helpers.js';
import { checkout, orderStatus, sellingEvent, fakePaystack, prisma, buyerEmail, type Selling } from './orders-helpers.js';

// ─────────────────────────────────────────
//  CHECKOUT (ticket sales Round B) — POST /api/ticket-orders/checkout
//
//  Public, no sign-in. Refused, in the buyer's words with its own code,
//  for an event not selling, a type not on sale (South African time), an
//  event already over, too many tickets, or not enough left. Stock is held
//  atomically for 30 minutes; the same checkout comes back for the same key,
//  or the same buyer and items while pending. Paystack gets the split.
// ─────────────────────────────────────────

beforeEach(() => {
  installFirebaseMock();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await cleanupTicketSalesFixtures();
});

const refusal = async (s: Selling, items: { ticketTypeId: string; quantity: number }[], overrides: Record<string, unknown> = {}) => {
  const res = await checkout(s, items, overrides);
  return { status: res.status, code: res.body.code as string, message: res.body.message as string };
};

describe('a checkout that works', () => {
  it('holds the stock, snapshots the order, and starts a split Paystack checkout', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 2 }, { ticketTypeId: s.saturday, quantity: 1 }]);
    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data).toMatchObject({ status: 'PENDING', reused: false, tickets: [] });
    expect(data.authorizationUrl).toMatch(/^https:\/\/checkout\.paystack\.test\//);
    expect(data.orderToken).toMatch(new RegExp(`^${data.orderId}\\.[A-Za-z0-9_-]{43}$`));

    const fees = calculateTicketOrderFees({ unitPriceCents: 55_000, quantity: 1 });
    expect(data.amounts).toMatchObject({ subtotalCents: 55_000, totalCents: fees.totalCents, feesCents: fees.transactionChargeCents });

    const order = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: data.orderId }, include: { items: true, payments: true } });
    expect(order).toMatchObject({ subaccountCode: s.subaccountCode, termsVersion: TERMS_VERSION, buyerPhone: '+27821234567', transactionChargeCents: fees.transactionChargeCents });
    expect(order.holdExpiresAt.getTime() - order.createdAt.getTime()).toBeGreaterThanOrEqual(29 * 60_000);
    expect(order.items.map((i) => [i.typeName, i.quantity, i.unitPriceCents])).toEqual(expect.arrayContaining([['General', 2, 20_000], ['Saturday', 1, 15_000]]));

    const held = await prisma.ticket.findMany({ where: { id: { in: [s.general, s.saturday] } } });
    expect(held.find((t) => t.id === s.general)?.heldCount).toBe(2);
    expect(held.find((t) => t.id === s.saturday)?.heldCount).toBe(1);

    const init = fakePaystack.callsTo('POST', '/transaction/initialize').at(-1)!;
    expect(init.body).toMatchObject({
      amount: fees.totalCents,
      reference: order.payments[0]!.reference,
      subaccount: s.subaccountCode,
      transaction_charge: fees.transactionChargeCents,
      bearer: 'account',
      channels: ['card', 'eft', 'capitec_pay'],
      metadata: { orderId: order.id, kind: 'TICKET_ORDER' },
    });
  }, 60000);
});

describe('refusals', () => {
  it('the event not selling: not paid, private, a draft, cancelled, archived, paused', async () => {
    const s = await sellingEvent();
    const set = (data: Record<string, unknown>) => prisma.event.update({ where: { id: s.ev.eventId }, data });

    await set({ ticketing: 'FREE' });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 1 }])).toMatchObject({ status: 409, code: 'TICKET_ORDER_NOT_ON_SALE' });
    await set({ ticketing: 'PAID', status: 'DRAFT' });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 1 }])).toMatchObject({ status: 409, code: 'TICKET_ORDER_NOT_ON_SALE' });
    await set({ status: 'PUBLISHED', visibility: 'PRIVATE' });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 1 }])).toMatchObject({ status: 404, code: 'TICKET_ORDER_EVENT_NOT_FOUND' });
    await set({ visibility: 'PUBLIC', status: 'CANCELLED' });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 1 }])).toMatchObject({ status: 410, code: 'TICKET_ORDER_EVENT_CANCELLED', message: 'This event has been cancelled.' });
    await set({ status: 'PUBLISHED', isArchived: true });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 1 }])).toMatchObject({ status: 404, code: 'TICKET_ORDER_EVENT_NOT_FOUND' });
    await set({ isArchived: false, salesPaused: true });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 1 }])).toMatchObject({ status: 409, code: 'TICKET_ORDER_SALES_PAUSED' });
    await set({ salesPaused: false });
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    expect((await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }])).status).toBe(404);
    vi.unstubAllEnvs();
    expect(await prisma.ticketOrder.count({ where: { eventId: s.ev.eventId } })).toBe(0);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).heldCount).toBe(0);
  }, 60000);

  it('a type not ACTIVE, or another event\'s', async () => {
    const s = await sellingEvent();
    const other = await sellingEvent();
    await prisma.ticket.update({ where: { id: s.saturday }, data: { status: 'HIDDEN' } });
    expect(await refusal(s, [{ ticketTypeId: s.saturday, quantity: 1 }])).toMatchObject({ status: 409, code: 'TICKET_ORDER_TYPE_UNAVAILABLE' });
    expect(await refusal(s, [{ ticketTypeId: other.general, quantity: 1 }])).toMatchObject({ status: 409, code: 'TICKET_ORDER_TYPE_UNAVAILABLE' });
  }, 60000);

  it('the sales window, in South African time: not yet open, and closed', async () => {
    const s = await sellingEvent();
    // Opens 10:00 SA on 1 February 2027.
    await prisma.ticket.update({ where: { id: s.general }, data: { salesStart: parseSaLocal('2027-02-01T10:00')!, salesEnd: parseSaLocal('2027-02-10T18:00')! } });
    const at = (local: string) =>
      ticketOrderService
        .checkout(
          { shareToken: s.ev.shareToken, items: [{ ticketTypeId: s.general, quantity: 1 }], buyer: { name: 'A', email: buyerEmail() }, termsAccepted: true, idempotencyKey: `k-${Math.random().toString(36).slice(2)}-0000000000` },
          parseSaLocal(local)!
        )
        .catch((e: { statusCode: number; code: string }) => e);
    expect(await at('2027-02-01T09:59')).toMatchObject({ statusCode: 409, code: 'TICKET_ORDER_TYPE_NOT_YET_ON_SALE' });
    expect(await at('2027-02-01T10:00')).toMatchObject({ status: 'PENDING' });
    expect(await at('2027-02-10T18:00')).toMatchObject({ statusCode: 409, code: 'TICKET_ORDER_TYPE_SALES_ENDED' });
  }, 60000);

  it("the event's last day has ended, even with the type's own window still open (days moved earlier after it was saved)", async () => {
    const s = await sellingEvent();
    // The type was saved with sales to 5 March; the event's days were moved
    // earlier since, its last day now ending 2 March, 23:59 South African time.
    await prisma.ticket.update({ where: { id: s.general }, data: { salesEnd: parseSaLocal('2027-03-05T20:00')! } });
    const at = (local: string) =>
      ticketOrderService
        .checkout(
          { shareToken: s.ev.shareToken, items: [{ ticketTypeId: s.general, quantity: 1 }], buyer: { name: 'A', email: buyerEmail() }, termsAccepted: true, idempotencyKey: `k-${Math.random().toString(36).slice(2)}-0000000000` },
          parseSaLocal(local)!
        )
        .catch((e: { statusCode: number; code: string }) => e);
    expect(await at('2027-03-02T23:58')).toMatchObject({ status: 'PENDING' });
    // 00:30 in South Africa is still 2 March in UTC, when the event's own
    // status (read as UTC) hasn't finished yet: the SA-time check refuses it.
    expect(await at('2027-03-03T00:30')).toMatchObject({ statusCode: 410, code: 'TICKET_ORDER_EVENT_ENDED' });
  }, 60000);

  it('more than a type\'s maxPerOrder, or more than 20 in the order', async () => {
    const s = await sellingEvent({ generalQuantity: 100, saturdayQuantity: 50 });
    await prisma.ticket.update({ where: { id: s.saturday }, data: { maxPerOrder: 3 } });
    expect(await refusal(s, [{ ticketTypeId: s.saturday, quantity: 4 }])).toMatchObject({
      status: 422, code: 'TICKET_ORDER_TOO_MANY_OF_TYPE', message: "You can buy at most 3 'Saturday' tickets in one order.",
    });
    await prisma.ticket.update({ where: { id: s.general }, data: { maxPerOrder: 20 } });
    await prisma.ticket.update({ where: { id: s.saturday }, data: { maxPerOrder: 20 } });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 18 }, { ticketTypeId: s.saturday, quantity: 3 }])).toMatchObject({
      status: 422, code: 'TICKET_ORDER_TOO_MANY_TICKETS', message: 'One order can have at most 20 tickets.',
    });
  }, 60000);

  it("not enough left: the refusal says how many are; sold and held both count", async () => {
    const s = await sellingEvent({ saturdayQuantity: 5 });
    await prisma.ticket.update({ where: { id: s.saturday }, data: { soldCount: 2, heldCount: 1 } });
    expect(await refusal(s, [{ ticketTypeId: s.saturday, quantity: 3 }])).toMatchObject({
      status: 409, code: 'TICKET_ORDER_NOT_ENOUGH_LEFT', message: "Only 2 'Saturday' tickets are left.",
    });
    await prisma.ticket.update({ where: { id: s.saturday }, data: { soldCount: 4 } });
    expect(await refusal(s, [{ ticketTypeId: s.saturday, quantity: 1 }])).toMatchObject({ code: 'TICKET_ORDER_NOT_ENOUGH_LEFT', message: "'Saturday' tickets are sold out." });
    // A refusal on one type holds nothing on any.
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).heldCount).toBe(0);
  }, 60000);

  it('the buyer: a name, a valid email, a real phone if given, and the Terms', async () => {
    const s = await sellingEvent();
    const one = [{ ticketTypeId: s.general, quantity: 1 }];
    expect(await refusal(s, one, { buyer: { name: ' ', email: buyerEmail() } })).toMatchObject({ status: 422, code: 'TICKET_ORDER_BUYER_NAME_REQUIRED' });
    expect(await refusal(s, one, { buyer: { name: 'A', email: 'nope' } })).toMatchObject({ status: 422, code: 'TICKET_ORDER_BUYER_EMAIL_INVALID' });
    expect(await refusal(s, one, { buyer: { name: 'A', email: buyerEmail(), phone: '123' } })).toMatchObject({ status: 422 });
    expect(await refusal(s, one, { termsAccepted: false })).toMatchObject({ status: 422, code: 'TICKET_ORDER_TERMS_REQUIRED' });
    expect(await refusal(s, one, { idempotencyKey: 'short' })).toMatchObject({ status: 400, code: 'TICKET_ORDER_REQUEST_INVALID' });
  }, 60000);

  it('no active payout account: refused, never a checkout without a split', async () => {
    const s = await sellingEvent();
    await prisma.tenant.update({ where: { id: s.org.tenantId }, data: { paystackSubaccountStatus: 'PENDING' } });
    expect(await refusal(s, [{ ticketTypeId: s.general, quantity: 1 }])).toMatchObject({ status: 409, code: 'TICKET_ORDER_PAYMENTS_UNAVAILABLE' });
  }, 60000);

  it('no plan check: a paid event on an organisation since moved to Spark still sells', async () => {
    const s = await sellingEvent();
    await prisma.tenant.update({ where: { id: s.org.tenantId }, data: { subscriptionTier: 'SPARK' } });
    expect((await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }])).status).toBe(201);
  }, 60000);
});

describe('holds and the same checkout', () => {
  it('two buyers racing for the last ticket: one hold, one refusal', async () => {
    const s = await sellingEvent({ saturdayQuantity: 1 });
    const [a, b] = await Promise.all([
      checkout(s, [{ ticketTypeId: s.saturday, quantity: 1 }]),
      checkout(s, [{ ticketTypeId: s.saturday, quantity: 1 }]),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body.code, b.body.code]).toContain('TICKET_ORDER_NOT_ENOUGH_LEFT');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.saturday } })).heldCount).toBe(1);
    expect(await prisma.ticketOrder.count({ where: { eventId: s.ev.eventId } })).toBe(1);
  }, 60000);

  it('the same idempotency key, or the same buyer and items while pending, returns the same checkout: no second hold or charge', async () => {
    const s = await sellingEvent();
    const email = buyerEmail();
    const items = [{ ticketTypeId: s.general, quantity: 2 }];
    const first = await checkout(s, items, { idempotencyKey: 'same-key-0123456789', buyer: { name: 'Thandi', email } });
    expect(first.status).toBe(201);

    const sameKey = await checkout(s, items, { idempotencyKey: 'same-key-0123456789', buyer: { name: 'Thandi', email } });
    expect(sameKey.status).toBe(200);
    expect(sameKey.body.data).toMatchObject({ orderId: first.body.data.orderId, reused: true, authorizationUrl: first.body.data.authorizationUrl, orderToken: first.body.data.orderToken });

    // Another request, same buyer and items: the same checkout, without the token.
    const sameBuyer = await checkout(s, items, { buyer: { name: 'Thandi', email: email.toUpperCase() } });
    expect(sameBuyer.status).toBe(200);
    expect(sameBuyer.body.data).toMatchObject({ orderId: first.body.data.orderId, reused: true, orderToken: null, authorizationUrl: first.body.data.authorizationUrl });

    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).heldCount).toBe(2);
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(1);
    expect(await prisma.ticketOrder.count({ where: { eventId: s.ev.eventId } })).toBe(1);

    // Different items: a new order.
    expect((await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }], { buyer: { name: 'Thandi', email } })).status).toBe(201);
  }, 60000);

  it('the hold is released when it runs out (the expiry job), and the order is EXPIRED', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 3 }]);
    const { ticketOrderWorker } = await import('../../src/modules/ticket-order/ticket-order.worker.js');
    expect(await ticketOrderWorker.runOnce({ now: new Date(Date.now() + 29 * 60_000), eventIds: [s.ev.eventId] })).toMatchObject({ expired: 0 });
    expect(await ticketOrderWorker.runOnce({ now: new Date(Date.now() + 31 * 60_000), eventIds: [s.ev.eventId] })).toMatchObject({ expired: 1 });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.general } })).heldCount).toBe(0);
    expect((await prisma.ticketOrder.findUniqueOrThrow({ where: { id: res.body.data.orderId } })).status).toBe('EXPIRED');
  }, 60000);
});

describe('a free event, or one not yet on sale', () => {
  it('sales switched off: refused before anything is held', async () => {
    const org = await createOrg();
    await givePayoutAccount(org.tenantId);
    const ev = await createTicketedEvent(org);
    const type = await createType(org.admin, ev.eventId);
    const res = await checkout({ ev }, [{ ticketTypeId: type.body.data.id, quantity: 1 }]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_ORDER_NOT_ON_SALE');
    expect((await setSales(org.admin, ev.eventId, { enabled: true })).status).toBe(200);
    expect((await checkout({ ev }, [{ ticketTypeId: type.body.data.id, quantity: 1 }])).status).toBe(201);
  }, 60000);
});

describe("the order view's link back to the event (fix/payments-go-live)", () => {
  it("carries the event's share token while it is public", async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    expect(res.status).toBe(201);
    expect(res.body.data.event).toMatchObject({ shareToken: s.ev.shareToken });
    const view = await orderStatus(res.body.data.orderToken);
    expect(view.body.data.event).toMatchObject({ shareToken: s.ev.shareToken });
  }, 60000);

  it('is null once the event is archived', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    await prisma.event.update({ where: { id: s.ev.eventId }, data: { isArchived: true } });
    const view = await orderStatus(res.body.data.orderToken);
    expect(view.status).toBe(200);
    expect(view.body.data.event.shareToken).toBeNull();
  }, 60000);

  it('is null once the event is made private', async () => {
    const s = await sellingEvent();
    const res = await checkout(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    await prisma.event.update({ where: { id: s.ev.eventId }, data: { visibility: 'PRIVATE' } });
    const view = await orderStatus(res.body.data.orderToken);
    expect(view.status).toBe(200);
    expect(view.body.data.event.shareToken).toBeNull();
  }, 60000);
});
