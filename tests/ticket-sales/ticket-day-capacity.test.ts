import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { view } from '../public-events/helpers.js';
import { acceptedGuest } from '../event-day/day-capacity-fixtures.js';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import { ticketOrderWorker } from '../../src/modules/ticket-order/ticket-order.worker.js';
import { ticketOrderRepository } from '../../src/modules/ticket-order/ticket-order.repository.js';
import { dayFullMessage } from '../../src/modules/ticket/ticket-day-capacity.util.js';
import { cleanupTicketSalesFixtures, createType, ticketsUrl } from './helpers.js';
import { buyAndPay, checkout, latestReference, pay, sellingEvent, sendWebhook, prisma, type Selling } from './orders-helpers.js';

// ─────────────────────────────────────────
//  TICKET SALES AND DAY CAPACITY (STEERING "Venue", "Ticket sales")
//
//  Ticket sales stop when a day is full: sold + held + attending guests +
//  this order's tickets admitting the day must fit its capacity (409
//  TICKET_ORDER_DAY_FULL), checked under a lock on the days. Guests are
//  never refused, only warned about. A late payment is honoured and flagged
//  oversold. Organisers see sold tickets in attendingCount and the
//  warnings (never holds); the public sees only each type's availability.
//
//  The fixture (sellingEvent): Day 1 (2027-03-01) and Day 2 (2027-03-02),
//  'General' (R200, 100, every day) and 'Saturday' (R150, 5, Day 2 only).
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanupTicketSalesFixtures();
});

const DAY1 = 0;
const DAY2 = 1;
const setCapacity = (s: Selling, day: number, capacity: number | null) =>
  prisma.eventDay.update({ where: { id: s.ev.dayIds[day]! }, data: { capacity } });

const buy = async (s: Selling, ticketTypeId: string, quantity: number) => {
  const res = await checkout(s, [{ ticketTypeId, quantity }]);
  return { status: res.status, code: res.body.code as string | undefined, message: res.body.message as string | undefined, details: res.body.details, orderId: res.body.data?.orderId as string | undefined, token: res.body.data?.orderToken as string | undefined };
};

const detail = async (s: Selling) => (await request(app).get(`/api/events/${s.ev.eventId}`).set(headersFor(s.org.admin))).body.data;
const attendingCounts = async (s: Selling) =>
  Object.fromEntries((await detail(s)).eventDays.map((d: { label: string; attendingCount: number }) => [d.label, d.attendingCount]));

// Accepted guests on these days, through the app's own invite and RSVP.
const guestsOn = async (s: Selling, dayIds: string[], count: number) => {
  for (let i = 0; i < count; i++) await acceptedGuest({ tenantId: s.org.tenantId, organiser: s.org.admin, eventId: s.ev.eventId, days: {} }, dayIds);
};

const publicType = async (s: Selling, name: string) =>
  (await view(s.ev.shareToken)).body.data.ticketSales.ticketTypes.find((t: { name: string }) => t.name === name) as { availability: string; remaining: number | null };

describe('checkout counts every ticket admitting the day', () => {
  it('two types sharing a day can’t go past its capacity together', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY2, 3);
    expect((await buy(s, s.general, 2)).status).toBe(201); // Day 2: 2 of 3
    const over = await buy(s, s.saturday, 2);
    expect(over).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Only 1 place is left on Day 2.' });
    expect(over.details).toEqual({ eventDayId: s.ev.dayIds[DAY2], dayLabel: 'Day 2', remaining: 1, days: [{ eventDayId: s.ev.dayIds[DAY2], dayLabel: 'Day 2', remaining: 1 }] });
    // The refusal held nothing, on either type.
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.saturday } })).heldCount).toBe(0);
    expect((await buy(s, s.saturday, 1)).status).toBe(201);
    expect(await buy(s, s.general, 1)).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Day 2 is sold out.' });
  });

  it('a Day-2-only type doesn’t use Day 1’s capacity', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 1);
    expect((await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 3 }])).tickets).toHaveLength(3);
    expect((await buy(s, s.saturday, 1)).status).toBe(201); // and a hold
    expect((await buy(s, s.general, 1)).status).toBe(201); // Day 1's one place
    expect(await buy(s, s.general, 1)).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Day 1 is sold out.' });
  });

  it('attending guests and tickets share the count; the organiser’s attendingCount includes sold tickets', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 3);
    await guestsOn(s, [s.ev.dayIds[DAY1]!], 2);
    expect(await buy(s, s.general, 2)).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Only 1 place is left on Day 1.' });
    await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    expect(await attendingCounts(s)).toEqual({ 'Day 1': 3, 'Day 2': 1 });
    expect((await detail(s)).capacityWarnings).toEqual([]); // at capacity, not over
  });

  it('holds count at checkout, but never in attendingCount or the warnings', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 2);
    expect((await buy(s, s.general, 2)).status).toBe(201); // held, not paid
    expect(await attendingCounts(s)).toEqual({ 'Day 1': 0, 'Day 2': 0 });
    await setCapacity(s, DAY1, 1);
    expect((await detail(s)).capacityWarnings).toEqual([]);
    await setCapacity(s, DAY1, 2);
    expect(await buy(s, s.general, 1)).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Day 1 is sold out.' });
  });

  it('buyers racing for a day’s last place, on different types: exactly one hold', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY2, 1);
    // Widen the race: each type hold (after the days are locked, before they
    // are counted) takes a second, so the two checkouts' transactions
    // overlap. Of different types, nothing but the day lock orders them.
    const realHold = ticketOrderRepository.hold;
    vi.spyOn(ticketOrderRepository, 'hold').mockImplementation(async (tx, id, quantity) => {
      const held = await realHold(tx, id, quantity);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return held;
    });
    const results = await Promise.all([s.general, s.saturday].map((t) => checkout(s, [{ ticketTypeId: t, quantity: 1 }])));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'TICKET_ORDER_DAY_FULL')).toBe(true);
    expect(await prisma.ticketOrder.count({ where: { eventId: s.ev.eventId } })).toBe(1);
  });

  it('days with no capacity, and online days, are unlimited', async () => {
    const s = await sellingEvent();
    await prisma.eventDay.update({ where: { id: s.ev.dayIds[DAY1]! }, data: { locationType: 'ONLINE', location: null, address: null, capacity: null } });
    await setCapacity(s, DAY2, null);
    for (let i = 0; i < 3; i++) expect((await buy(s, s.general, 10)).status).toBe(201);
    expect((await buy(s, s.saturday, 5)).status).toBe(201);
    expect(await publicType(s, 'General')).toMatchObject({ availability: 'ON_SALE', remaining: null });
  });
});

describe('the refusal: TICKET_ORDER_DAY_FULL', () => {
  it('words 0 and N left; several short days name the first by date and list them all; NOT_ENOUGH_LEFT is checked first', async () => {
    expect(dayFullMessage('Saturday', 0)).toBe('Saturday is sold out.');
    expect(dayFullMessage('Saturday', 3)).toBe('Only 3 places are left on Saturday.');
    expect(dayFullMessage('Saturday', 1)).toBe('Only 1 place is left on Saturday.');

    const s = await sellingEvent();
    await setCapacity(s, DAY2, 4);
    await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]); // Saturday: 4 of 5 left; Day 2: 3 of 4
    expect(await buy(s, s.general, 4)).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Only 3 places are left on Day 2.', details: { remaining: 3 } });
    await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 3 }]); // Day 2 full; Saturday still has 4

    // Both short: the type's own quantity is reported.
    expect(await buy(s, s.saturday, 5)).toMatchObject({ status: 409, code: 'TICKET_ORDER_NOT_ENOUGH_LEFT', message: "Only 4 'Saturday' tickets are left." });
    expect(await buy(s, s.saturday, 1)).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Day 2 is sold out.', details: { remaining: 0 } });

    // Day 1 (earlier) and Day 2 both short.
    await setCapacity(s, DAY1, 4); // 3 sold
    const both = await buy(s, s.general, 2);
    expect(both).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Only 1 place is left on Day 1.' });
    expect(both.details).toEqual({
      eventDayId: s.ev.dayIds[DAY1],
      dayLabel: 'Day 1',
      remaining: 1,
      days: [
        { eventDayId: s.ev.dayIds[DAY1], dayLabel: 'Day 1', remaining: 1 },
        { eventDayId: s.ev.dayIds[DAY2], dayLabel: 'Day 2', remaining: 0 },
      ],
    });
  });

  it('a retry is refused when the day filled meanwhile', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY2, 1);
    const first = await buy(s, s.saturday, 1);
    await ticketOrderWorker.runOnce({ now: new Date(Date.now() + 31 * 60_000), eventIds: [s.ev.eventId] });
    await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const retry = await request(app).post('/api/ticket-orders/retry').send({ token: first.token });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: 'TICKET_ORDER_DAY_FULL', message: 'Day 2 is sold out.' });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.saturday } })).heldCount).toBe(0);
  });
});

describe('guests and late payments', () => {
  it('a guest RSVP on a full day is still accepted, and only warns the organiser', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 1);
    await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const invited = await acceptedGuest({ tenantId: s.org.tenantId, organiser: s.org.admin, eventId: s.ev.eventId, days: {} }, [s.ev.dayIds[DAY1]!]);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invited.invite.id } })).status).toBe('ACCEPTED');
    const again = await rsvpService.submit({ token: invited.invite.token, attending: true, attendingDayIds: [s.ev.dayIds[DAY1]!] });
    expect(JSON.stringify(again)).not.toMatch(/"(capacity|attendingCount|capacityWarnings)":/);
    expect((await detail(s)).capacityWarnings).toEqual([
      { eventDayId: s.ev.dayIds[DAY1], label: 'Day 1', capacity: 1, attending: 2, message: 'Day 1 has 2 people attending, over its venue capacity of 1.' },
    ]);
  });

  it('a payment after its hold was given back is honoured past the day’s capacity, and flagged oversold', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY2, 1);
    const late = await buy(s, s.general, 1);
    await ticketOrderWorker.runOnce({ now: new Date(Date.now() + 31 * 60_000), eventIds: [s.ev.eventId] });
    await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]); // the day's place, meanwhile
    clearSentEmails();

    await pay(await latestReference(late.orderId!));
    const order = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: late.orderId! }, include: { tickets: true } });
    expect(order).toMatchObject({ status: 'PAID', oversold: true });
    expect(order.tickets).toHaveLength(1);
    expect(await attendingCounts(s)).toEqual({ 'Day 1': 1, 'Day 2': 2 });
    const email = sentEmails().find((e) => e.to === s.org.admin.email && /More tickets sold than available/.test(e.subject));
    expect(email?.text).toContain('More people now have places on Day 2 than the venue holds.');
  });

  it('a payment after its hold expired (not yet given back) is flagged too: the expired hold never counted', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY2, 1);
    const late = await buy(s, s.general, 1);
    await prisma.ticketOrder.update({ where: { id: late.orderId! }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
    await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]); // the expired hold doesn't count
    await pay(await latestReference(late.orderId!));
    expect(await prisma.ticketOrder.findUniqueOrThrow({ where: { id: late.orderId! } })).toMatchObject({ status: 'PAID', oversold: true });
  });

  it('a payment from a standing hold is never flagged for the day', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY2, 1);
    const { orderId } = await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]);
    expect(await prisma.ticketOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'PAID', oversold: false });
  });
});

describe('the public page: effective remaining', () => {
  it('SOLD_OUT and "only N left" follow the lowest of the type’s own remaining and its days’ places left (holds counted); capacity never shown', async () => {
    const s = await sellingEvent({ generalQuantity: 100, saturdayQuantity: 5 });
    await setCapacity(s, DAY1, 50);
    await setCapacity(s, DAY2, 4);
    expect(await publicType(s, 'Saturday')).toMatchObject({ availability: 'ON_SALE', remaining: 4 }); // the day: 4 < 5
    expect(await publicType(s, 'General')).toMatchObject({ availability: 'ON_SALE', remaining: 4 }); // Day 2 limits it too

    await setCapacity(s, DAY2, 40);
    expect(await publicType(s, 'Saturday')).toMatchObject({ remaining: 5 }); // its own: 5 < 40
    expect(await publicType(s, 'General')).toMatchObject({ remaining: null }); // 40 left: over 10

    await setCapacity(s, DAY2, 3);
    expect((await buy(s, s.saturday, 3)).status).toBe(201); // held, not paid
    expect(await publicType(s, 'Saturday')).toMatchObject({ availability: 'SOLD_OUT', remaining: null });
    expect(await publicType(s, 'General')).toMatchObject({ availability: 'SOLD_OUT', remaining: null });

    const body = JSON.stringify((await view(s.ev.shareToken)).body.data);
    expect(body).not.toMatch(/"capacity":/);
    expect(body).not.toMatch(/attendingCount|capacityWarnings/);
  });
});

describe('organiser warnings', () => {
  it('the ticket types list warns when the active types for a day add up to more than its capacity; saving still succeeds', async () => {
    const s = await sellingEvent({ generalQuantity: 100, saturdayQuantity: 5 });
    await setCapacity(s, DAY1, 200);
    await setCapacity(s, DAY2, 50);
    const list = async () => request(app).get(ticketsUrl(s.ev.eventId)).set(headersFor(s.org.admin));

    const res = await list();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.capacityWarnings).toEqual([
      { eventDayId: s.ev.dayIds[DAY2], label: 'Day 2', capacity: 50, ticketQuantity: 105, message: 'Your ticket types for Day 2 add up to 105, but the venue holds 50. Ticket sales stop at 50.' },
    ]);

    // Another type pushing Day 1 over: saved, and warned.
    const vip = await createType(s.org.admin, s.ev.eventId, { name: 'VIP', quantity: 150, admittedDayIds: [s.ev.dayIds[DAY1]] });
    expect(vip.status).toBe(201);
    expect((await list()).body.capacityWarnings.map((w: { message: string }) => w.message)).toEqual([
      'Your ticket types for Day 1 add up to 250, but the venue holds 200. Ticket sales stop at 200.',
      'Your ticket types for Day 2 add up to 105, but the venue holds 50. Ticket sales stop at 50.',
    ]);

    // A hidden type doesn't count.
    await request(app).put(`${ticketsUrl(s.ev.eventId)}/${vip.body.data.id}`).set(headersFor(s.org.admin)).send({ status: 'HIDDEN' });
    expect((await list()).body.capacityWarnings).toHaveLength(1);
  });

  it('lowering a day’s capacity below what’s sold is saved with a warning, and further sales for that day stop', async () => {
    const s = await sellingEvent();
    await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 3 }]);
    const res = await request(app).put(`/api/events/${s.ev.eventId}/days/${s.ev.dayIds[DAY2]}`).set(headersFor(s.org.admin)).send({ capacity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data.capacityWarnings).toEqual([
      { eventDayId: s.ev.dayIds[DAY2], label: 'Day 2', capacity: 2, attending: 3, message: 'Day 2 has 3 people attending, over its venue capacity of 2.' },
    ]);
    expect(await buy(s, s.general, 1)).toMatchObject({ status: 409, code: 'TICKET_ORDER_DAY_FULL', message: 'Day 2 is sold out.' });
    // Day 1 has no capacity: a Day-1-only type still sells.
    const friday = await createType(s.org.admin, s.ev.eventId, { name: 'Friday', quantity: 10, admittedDayIds: [s.ev.dayIds[DAY1]] });
    expect((await buy(s, friday.body.data.id, 1)).status).toBe(201);
  });
});

describe('freeing a place', () => {
  it('cancelling a ticket frees its place at once', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 1);
    const { orderId, tickets } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    expect((await buy(s, s.general, 1)).code).toBe('TICKET_ORDER_DAY_FULL');
    const cancelled = await request(app)
      .post(`/api/events/${s.ev.eventId}/ticket-sales/orders/${orderId}/cancel`)
      .set(headersFor(s.org.admin))
      .send({ reason: 'Venue change', ticketIds: [tickets[0]!.id] });
    expect(cancelled.status).toBe(200);
    expect((await buy(s, s.general, 1)).status).toBe(201);
  });

  it('a full refund frees the places at once', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 2);
    const { orderId } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 2 }]);
    expect((await buy(s, s.general, 1)).code).toBe('TICKET_ORDER_DAY_FULL');
    const order = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: orderId } });
    await sendWebhook('refund.processed', { id: 9_400_000 + Math.floor(Math.random() * 100_000), transaction_reference: order.paidReference, amount: order.totalCents, currency: 'ZAR', status: 'processed' });
    expect((await prisma.ticketOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('REFUNDED');
    expect((await buy(s, s.general, 2)).status).toBe(201);
  });

  it('a hold given back on expiry frees the place', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 1);
    expect((await buy(s, s.general, 1)).status).toBe(201);
    expect((await buy(s, s.general, 1)).code).toBe('TICKET_ORDER_DAY_FULL');
    await ticketOrderWorker.runOnce({ now: new Date(Date.now() + 31 * 60_000), eventIds: [s.ev.eventId] });
    expect((await buy(s, s.general, 1)).status).toBe(201);
  });
});

describe('the sales summary', () => {
  it('has a line per day: capacity, sold, held, guests and remaining (null with no capacity)', async () => {
    const s = await sellingEvent();
    await setCapacity(s, DAY1, 10);
    await guestsOn(s, [s.ev.dayIds[DAY1]!], 2);
    await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 2 }]); // both days
    expect((await buy(s, s.general, 1)).status).toBe(201); // held, both days
    expect((await buy(s, s.saturday, 1)).status).toBe(201); // held, Day 2

    const res = await request(app).get(`/api/events/${s.ev.eventId}/ticket-sales/summary`).set(headersFor(s.org.admin));
    expect(res.status).toBe(200);
    expect(res.body.data.days).toEqual([
      { eventDayId: s.ev.dayIds[DAY1], label: 'Day 1', capacity: 10, sold: 2, held: 1, guests: 2, remaining: 5 },
      { eventDayId: s.ev.dayIds[DAY2], label: 'Day 2', capacity: null, sold: 2, held: 2, guests: 0, remaining: null },
    ]);
  });
});
