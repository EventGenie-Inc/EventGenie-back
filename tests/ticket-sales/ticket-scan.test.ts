import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { mockResendSend } from '../setup.js';
import { buildPassPayload } from '../../src/modules/check-in-pass/check-in-pass-token.util.js';
import { planReconcile } from '../../src/modules/check-in-pass/check-in-pass.service.js';
import { cleanupTicketSalesFixtures, createType } from './helpers.js';
import { buyAndPay, sellingEvent, orderStatus, sendWebhook, prisma, type Selling } from './orders-helpers.js';

// ─────────────────────────────────────────
//  TICKETS AT THE DOOR (ticket sales Round B)
//
//  One QR per ticket (EVT1.<ticketId>.<sig>), valid once on each venue day
//  its type admits: GREEN, then AMBER. Another day is WRONG_DAY; a ticket
//  cancelled, refunded or charged back is TICKET_CANCELLED. The guest-list
//  check-in records the same row. The RSVP reconcile never touches tickets;
//  an RSVP-style code on a paid event admits nobody.
// ─────────────────────────────────────────

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});

afterEach(async () => {
  await cleanupTicketSalesFixtures();
});

const scan = (s: Selling, dayId: string, payload: unknown) =>
  request(app).post(`/api/events/${s.ev.eventId}/check-in/scan`).set(headersFor(s.org.admin)).send({ eventDayId: dayId, payload });
const payloadOf = (ticketId: string) => buildPassPayload({ id: ticketId, kind: 'TICKET' });

describe('scanning a ticket', () => {
  it('GREEN once on each admitted day, then AMBER; the buyer and "Ticket 1 of 2 · General"', async () => {
    const s = await sellingEvent();
    const { tickets } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 2 }]);
    const code = payloadOf(tickets[0]!.id);

    const first = (await scan(s, s.ev.dayIds[0]!, code)).body.data;
    expect(first).toMatchObject({
      result: 'GREEN',
      reason: null,
      person: { guestId: null, name: 'Thandi Nkosi', isPlusOne: false, guestOf: null, detail: 'Ticket 1 of 2 · General', ticketId: tickets[0]!.id, ticketNumber: tickets[0]!.number },
      day: { id: s.ev.dayIds[0] },
      table: null,
    });
    const again = (await scan(s, s.ev.dayIds[0]!, code)).body.data;
    expect(again).toMatchObject({ result: 'AMBER', reason: null, checkedInAt: first.checkedInAt });
    expect(again.message).toMatch(/^Already checked in at \d\d:\d\d/);
    // Its other admitted day: GREEN again, once.
    expect((await scan(s, s.ev.dayIds[1]!, code)).body.data.result).toBe('GREEN');
    expect((await scan(s, s.ev.dayIds[1]!, code)).body.data.result).toBe('AMBER');
    expect(await prisma.ticketCheckIn.count({ where: { issuedTicketId: tickets[0]!.id } })).toBe(2);
    // The other ticket of the order is its own admission.
    expect((await scan(s, s.ev.dayIds[0]!, payloadOf(tickets[1]!.id))).body.data.result).toBe('GREEN');
  }, 60000);

  it('a day its type does not admit: WRONG_DAY, naming its days', async () => {
    const s = await sellingEvent();
    const { tickets } = await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]);
    const res = (await scan(s, s.ev.dayIds[0]!, payloadOf(tickets[0]!.id))).body.data;
    expect(res).toMatchObject({ result: 'RED', reason: 'WRONG_DAY', message: 'This ticket is for Day 2.', day: { id: s.ev.dayIds[1] } });
    expect(res.person.detail).toBe('Ticket 1 of 1 · Saturday');
    expect(await prisma.ticketCheckIn.count({ where: { issuedTicketId: tickets[0]!.id } })).toBe(0);
  }, 60000);

  it('another event\'s ticket is WRONG_EVENT; a forged or altered code is INVALID', async () => {
    const s = await sellingEvent();
    const other = await sellingEvent();
    const { tickets } = await buyAndPay(other, [{ ticketTypeId: other.general, quantity: 1 }]);
    expect((await scan(s, s.ev.dayIds[0]!, payloadOf(tickets[0]!.id))).body.data.reason).toBe('WRONG_EVENT');
    const code = payloadOf(tickets[0]!.id);
    expect((await scan(other, other.ev.dayIds[0]!, `${code.slice(0, -2)}xx`)).body.data.reason).toBe('INVALID');
    expect((await scan(other, other.ev.dayIds[0]!, code.replace('EVT1', 'EV1'))).body.data.reason).toBe('INVALID');
  }, 60000);

  it('cancelled, refunded and charged-back-lost tickets: TICKET_CANCELLED', async () => {
    const s = await sellingEvent();
    // Cancelled by the organiser.
    const a = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const cancel = await request(app).post(`/api/events/${s.ev.eventId}/ticket-sales/orders/${a.orderId}/cancel`).set(headersFor(s.org.admin)).send({ reason: 'Duplicate booking' });
    expect(cancel.status).toBe(200);
    // Refunded in full through Paystack.
    const b = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const bOrder = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: b.orderId } });
    await sendWebhook('refund.processed', { id: 9_100_001, transaction_reference: bOrder.paidReference, amount: bOrder.totalCents, currency: 'ZAR', status: 'processed' });
    // Charged back, lost.
    const c = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 1 }]);
    const cOrder = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: c.orderId } });
    await sendWebhook('charge.dispute.resolve', { id: 9_100_002, transaction: { reference: cOrder.paidReference }, amount: cOrder.totalCents, currency: 'ZAR', resolution: 'merchant-accepted' });

    for (const [order, status] of [[a, 'CANCELLED'], [b, 'REFUNDED'], [c, 'REVERSED']] as const) {
      expect((await prisma.issuedTicket.findUniqueOrThrow({ where: { id: order.tickets[0]!.id } })).status).toBe(status);
      const res = (await scan(s, s.ev.dayIds[0]!, payloadOf(order.tickets[0]!.id))).body.data;
      expect(res, status).toMatchObject({ result: 'RED', reason: 'TICKET_CANCELLED', message: 'This ticket has been cancelled.', person: null });
    }
  }, 60000);
});

describe('the guest list, the reconcile, and RSVP codes', () => {
  it('the door list has the tickets by buyer; checking one in from the list makes its scan AMBER; undo makes it GREEN again', async () => {
    const s = await sellingEvent();
    const { tickets } = await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 2 }]);
    const h = headersFor(s.org.admin);
    const roster = (await request(app).get(`/api/events/${s.ev.eventId}/check-in/days/${s.ev.dayIds[0]}`).set(h)).body.data;
    expect(roster.ticketCounts).toEqual({ valid: 2, arrived: 0 });
    expect(roster.tickets[0]).toMatchObject({ ticketId: tickets[0]!.id, ticketNumber: tickets[0]!.number, buyerName: 'Thandi Nkosi', typeName: 'General', label: 'Ticket 1 of 2', checkedIn: false });

    const listed = await request(app).post(`/api/events/${s.ev.eventId}/check-in/days/${s.ev.dayIds[0]}`).set(h).send({ ticketId: tickets[0]!.id });
    expect(listed.status).toBe(201);
    expect(listed.body.data).toMatchObject({ created: true, guest: null, ticket: { ticketId: tickets[0]!.id, checkedIn: true } });
    expect((await scan(s, s.ev.dayIds[0]!, payloadOf(tickets[0]!.id))).body.data.result).toBe('AMBER');

    const undo = await request(app).delete(`/api/events/${s.ev.eventId}/check-in/days/${s.ev.dayIds[0]}/tickets/${tickets[0]!.id}`).set(h);
    expect(undo.body.data).toMatchObject({ removed: true, ticket: { checkedIn: false } });
    expect((await scan(s, s.ev.dayIds[0]!, payloadOf(tickets[0]!.id))).body.data.result).toBe('GREEN');
    // A day the ticket doesn't admit, from the list too.
    const { tickets: sat } = await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]);
    const wrong = await request(app).post(`/api/events/${s.ev.eventId}/check-in/days/${s.ev.dayIds[0]}`).set(h).send({ ticketId: sat[0]!.id });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('TICKET_WRONG_DAY');
  }, 60000);

  it('the RSVP reconcile leaves ticket passes alone', () => {
    const party = {
      id: 'g1', eventId: 'e1', firstName: 'A', surname: 'B', isArchived: false, pendingApproval: false, registrationDeclinedAt: null,
      invites: [], plusOnes: [],
      event: { id: 'e1', status: 'PUBLISHED', isArchived: false, ticketing: 'PAID', visibility: 'PUBLIC', eventDays: [] },
    } as unknown as Parameters<typeof planReconcile>[0];
    const active = [
      { id: 'p1', eventId: 'e1', eventDayId: 'd1', guestId: 'g1', plusOneGuestId: null, kind: 'TICKET', status: 'ACTIVE' },
      { id: 'p2', eventId: 'e1', eventDayId: 'd1', guestId: 'g1', plusOneGuestId: null, kind: 'RSVP', status: 'ACTIVE' },
    ] as unknown as Parameters<typeof planReconcile>[1];
    const { stale } = planReconcile(party, active, true);
    expect(stale.map((p) => p.id)).toEqual(['p2']);
  });

  it('an RSVP-style code on a paid event admits nobody', async () => {
    const s = await sellingEvent();
    // A registrant from before sales were switched on, with an RSVP pass.
    // Accepted for Day 1, so without the paid-event rule the pass would admit them.
    const guest = await prisma.guest.create({ data: { eventId: s.ev.eventId, firstName: 'Early', email: `early-${Date.now()}@test.invalid` } });
    await prisma.invite.create({
      data: {
        eventId: s.ev.eventId,
        guestId: guest.id,
        token: `tok-${Date.now()}-${Math.random().toString(36).slice(2)}`.padEnd(64, '0'),
        deliveryMethod: 'EMAIL',
        status: 'ACCEPTED',
        createdBy: s.org.admin.id,
        updatedBy: s.org.admin.id,
        inviteEventDay: { create: [{ eventDayId: s.ev.dayIds[0]! }] },
        attendances: { create: [{ eventDayId: s.ev.dayIds[0]! }] },
      },
    });
    const pass = await prisma.checkInPass.create({ data: { eventId: s.ev.eventId, eventDayId: s.ev.dayIds[0]!, guestId: guest.id, kind: 'RSVP' } });
    const res = (await scan(s, s.ev.dayIds[0]!, buildPassPayload({ id: pass.id, kind: 'RSVP' }))).body.data;
    expect(res.result).toBe('RED');
    expect(['REVOKED', 'REPLACED']).toContain(res.reason);
    expect(await prisma.checkIn.count({ where: { invite: { guestId: guest.id } } })).toBe(0);
  }, 60000);
});

describe('online days', () => {
  it('an online-only ticket has no QR; the buyer gets the meeting link in the email and on the order page', async () => {
    const s = await sellingEvent();
    await prisma.eventDay.update({ where: { id: s.ev.dayIds[1]! }, data: { locationType: 'ONLINE', onlineUrl: 'https://meet.example.test/secret-room', location: null, address: null } });
    const online = await createType(s.org.admin, s.ev.eventId, { name: 'Stream', priceCents: 5_000, quantity: 10, admittedDayIds: [s.ev.dayIds[1]] });
    const { orderId, token, tickets } = await buyAndPay(s, [{ ticketTypeId: online.body.data.id, quantity: 1 }]);

    const view = (await orderStatus(token)).body.data;
    expect(view.tickets[0]).toMatchObject({ payload: null, days: [{ locationType: 'ONLINE', location: 'Online', onlineUrl: 'https://meet.example.test/secret-room' }] });
    const order = await prisma.ticketOrder.findUniqueOrThrow({ where: { id: orderId } });
    const email = sentEmails().find((e) => e.to === order.buyerEmail)!;
    expect(email.html).toContain('https://meet.example.test/secret-room');
    // Scanning it at a door: an online day has no door.
    expect((await scan(s, s.ev.dayIds[1]!, payloadOf(tickets[0]!.id))).body.data.reason).toBe('WRONG_DAY');
    void mockResendSend;
  }, 60000);
});
