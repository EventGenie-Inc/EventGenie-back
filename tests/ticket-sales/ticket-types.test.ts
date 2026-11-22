import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock, assign } from '../helpers/team.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import {
  cleanupTicketSalesFixtures,
  createOrg,
  createTicketedEvent,
  createType,
  updateType,
  simulateSale,
  ticketsUrl,
  prisma,
  VALID_TYPE,
} from './helpers.js';

// ─────────────────────────────────────────
//  TICKET TYPES (ticket sales Round A) — /api/events/:eventId/tickets
//
//  Price in whole cents, at least R10; a quantity; an optional sales window
//  ending no later than the event's last day; every day or chosen days (at
//  least one, the event's own); maxPerOrder 1 to 20 (default 10). After a
//  sale: not deleted (hidden instead), quantity not below what's sold, its
//  days fixed, and a day it admits can't be removed.
// ─────────────────────────────────────────

beforeEach(() => {
  installFirebaseMock();
});

afterEach(async () => {
  await cleanupTicketSalesFixtures();
});

const setup = async () => {
  const org = await createOrg();
  const ev = await createTicketedEvent(org);
  return { org, ev };
};

describe('validation', () => {
  it('R0 and anything under R10 are refused; R10 is the least', async () => {
    const { org, ev } = await setup();
    for (const priceCents of [0, 1, 999]) {
      const res = await createType(org.admin, ev.eventId, { priceCents });
      expect(res.status, String(priceCents)).toBe(422);
      expect(res.body.code).toBe('TICKET_PRICE_TOO_LOW');
      expect(res.body.message).toBe("'General admission' must cost at least R10.00. Tickets can't be free: for a free event, guests register instead.");
    }
    for (const priceCents of [-100, 150.5, '20000']) {
      const res = await createType(org.admin, ev.eventId, { priceCents });
      expect(res.status, String(priceCents)).toBe(422);
      expect(res.body.code).toMatch(/^TICKET_PRICE_/);
    }
    expect(await prisma.ticket.count({ where: { eventId: ev.eventId } })).toBe(0);

    const ok = await createType(org.admin, ev.eventId, { priceCents: 1_000 });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ priceCents: 1_000, currency: 'ZAR', quantity: 100, maxPerOrder: 10, status: 'ACTIVE', admittedDayIds: null, soldCount: 0, hasSales: false });
    // The deprecated decimal column is written in step.
    expect(Number((await prisma.ticket.findUniqueOrThrow({ where: { id: ok.body.data.id } })).price)).toBe(10);

    // An edit down to R0 is refused too.
    const zero = await updateType(org.admin, ev.eventId, ok.body.data.id, { priceCents: 0 });
    expect(zero.status).toBe(422);
    expect(zero.body.code).toBe('TICKET_PRICE_TOO_LOW');
  }, 60000);

  it('the old decimal price and its friends are refused by name', async () => {
    const { org, ev } = await setup();
    const res = await request(app).post(ticketsUrl(ev.eventId)).set(headersFor(org.admin)).send({ name: 'General', price: 200, totalQuantity: 10 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TICKET_FIELD_RENAMED', message: "'price' has been replaced: send 'priceCents' instead." });
  }, 60000);

  it('maxPerOrder is a whole number from 1 to 20 (default 10)', async () => {
    const { org, ev } = await setup();
    for (const maxPerOrder of [0, 21, 1.5, -1, '5']) {
      const res = await createType(org.admin, ev.eventId, { maxPerOrder });
      expect(res.status, String(maxPerOrder)).toBe(422);
      expect(res.body.code).toBe('TICKET_MAX_PER_ORDER_INVALID');
    }
    expect((await createType(org.admin, ev.eventId, { maxPerOrder: 1 })).body.data.maxPerOrder).toBe(1);
    expect((await createType(org.admin, ev.eventId, { name: 'Group', maxPerOrder: 20 })).body.data.maxPerOrder).toBe(20);
  }, 60000);

  it("sales can't end after the event's last day ends, or before they start", async () => {
    const { org, ev } = await setup();
    // The last day is 2 March 2027 with no end time: it ends at 23:59:59.999.
    const late = await createType(org.admin, ev.eventId, { salesEnd: '2027-03-03T00:00:00' });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('TICKET_SALES_END_AFTER_EVENT');

    const backwards = await createType(org.admin, ev.eventId, { salesStart: '2027-02-10T09:00:00', salesEnd: '2027-02-01T09:00:00' });
    expect(backwards.status).toBe(422);
    expect(backwards.body.code).toBe('TICKET_SALES_WINDOW_INVALID');

    const ok = await createType(org.admin, ev.eventId, { salesStart: '2027-01-01T09:00:00', salesEnd: '2027-03-02T18:00:00' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ salesStart: '2027-01-01T09:00:00.000Z', salesEnd: '2027-03-02T18:00:00.000Z' });

    // Moving the end past the event later is refused the same way.
    const moved = await updateType(org.admin, ev.eventId, ok.body.data.id, { salesEnd: '2027-03-05T00:00:00' });
    expect(moved.status).toBe(422);
    expect(moved.body.code).toBe('TICKET_SALES_END_AFTER_EVENT');
  }, 60000);

  it("admitted days: at least one, and only the event's own live days", async () => {
    const { org, ev } = await setup();
    const empty = await createType(org.admin, ev.eventId, { admittedDayIds: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.code).toBe('TICKET_ADMITTED_DAYS_REQUIRED');

    const other = await createTicketedEvent(org);
    const foreign = await createType(org.admin, ev.eventId, { admittedDayIds: [ev.dayIds[0], other.dayIds[0]] });
    expect(foreign.status).toBe(422);
    expect(foreign.body.code).toBe('TICKET_ADMITTED_DAY_UNKNOWN');

    await prisma.eventDay.update({ where: { id: ev.dayIds[1]! }, data: { isArchived: true } });
    const archived = await createType(org.admin, ev.eventId, { admittedDayIds: [ev.dayIds[1]] });
    expect(archived.status).toBe(422);
    expect(archived.body.code).toBe('TICKET_ADMITTED_DAY_UNKNOWN');
    await prisma.eventDay.update({ where: { id: ev.dayIds[1]! }, data: { isArchived: false } });
    expect(await prisma.ticket.count({ where: { eventId: ev.eventId } })).toBe(0);

    const saturday = await createType(org.admin, ev.eventId, { name: 'Saturday only', admittedDayIds: [ev.dayIds[1], ev.dayIds[1]] });
    expect(saturday.status).toBe(201);
    expect(saturday.body.data.admittedDayIds).toEqual([ev.dayIds[1]]);
    // null = every day.
    const every = await updateType(org.admin, ev.eventId, saturday.body.data.id, { admittedDayIds: null });
    expect(every.body.data.admittedDayIds).toBeNull();
  }, 60000);

  it('a type saved before these rules keeps saving unchanged, and meets them once edited', async () => {
    const { org, ev } = await setup();
    const legacy = await prisma.ticket.create({
      data: { eventId: ev.eventId, name: 'Old free', price: 0, priceCents: 0, totalQuantity: null, createdBy: org.admin.id, updatedBy: org.admin.id },
    });
    const full = (tickets: unknown[]) => request(app).put(`/api/events/${ev.eventId}/full`).set(headersFor(org.admin)).send({ tickets });
    expect((await full([{ id: legacy.id, name: 'Old free', priceCents: 0 }])).status).toBe(200);
    expect((await updateType(org.admin, ev.eventId, legacy.id, { name: 'Old free' })).status).toBe(200);

    const renamed = await updateType(org.admin, ev.eventId, legacy.id, { name: 'Renamed' });
    expect(renamed.status).toBe(422);
    expect(renamed.body.code).toBe('TICKET_PRICE_TOO_LOW');
    const fixed = await updateType(org.admin, ev.eventId, legacy.id, { name: 'Renamed', priceCents: 5_000 });
    expect(fixed.body.code).toBe('TICKET_QUANTITY_REQUIRED');
    expect((await updateType(org.admin, ev.eventId, legacy.id, { name: 'Renamed', priceCents: 5_000, quantity: 10 })).status).toBe(200);
  }, 60000);

  it('the wizard creates a public event\'s ticket types in cents, naming days by position', async () => {
    const { org } = await setup();
    const payload = {
      name: 'Festival',
      hostName: 'Acme Events',
      visibility: 'PUBLIC',
      days: [
        { label: 'Friday', date: '2030-05-03T00:00:00', location: 'Field', address: '1 Farm Road' },
        { label: 'Saturday', date: '2030-05-04T00:00:00', location: 'Field', address: '1 Farm Road' },
      ],
      tickets: [
        { name: 'Weekend', priceCents: 50_000, quantity: 200 },
        { name: 'Saturday only', priceCents: 30_000, quantity: 100, admittedDayIndexes: [1], maxPerOrder: 4 },
      ],
    };
    await eventDraftRepository.upsert(org.tenantId, org.admin.id, { currentStep: 4, payload });
    const created = await eventDraftService.materialize(org.tenantId, org.admin.id);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: created!.id }, include: { eventDays: true, tickets: { include: { admittedDays: true }, orderBy: { sortOrder: 'asc' } } } });
    expect(event.ticketing).toBe('FREE');
    const saturday = event.eventDays.find((d) => d.label === 'Saturday')!;
    expect(event.tickets.map((t) => [t.name, t.priceCents, t.totalQuantity, t.admitsAllDays, t.admittedDays.map((a) => a.eventDayId)])).toEqual([
      ['Weekend', 50_000, 200, true, []],
      ['Saturday only', 30_000, 100, false, [saturday.id]],
    ]);

    // A position that isn't one of the draft's days is refused.
    await eventDraftRepository.upsert(org.tenantId, org.admin.id, { currentStep: 4, payload: { ...payload, tickets: [{ name: 'X', priceCents: 2_000, quantity: 1, admittedDayIndexes: [5] }] } });
    await expect(eventDraftService.materialize(org.tenantId, org.admin.id)).rejects.toMatchObject({ statusCode: 422, code: 'TICKET_ADMITTED_DAY_UNKNOWN' });
  }, 60000);
});

describe('after a sale', () => {
  const sold = async () => {
    const { org, ev } = await setup();
    const res = await createType(org.admin, ev.eventId, { name: 'Saturday', admittedDayIds: [ev.dayIds[1]], quantity: 50 });
    expect(res.status).toBe(201);
    await simulateSale(res.body.data.id, 3);
    return { org, ev, ticketId: res.body.data.id as string };
  };

  it("it can't be deleted, only hidden", async () => {
    const { org, ev, ticketId } = await sold();
    const del = await request(app).delete(`${ticketsUrl(ev.eventId)}/${ticketId}`).set(headersFor(org.admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('TICKET_TYPE_HAS_SALES');
    // Not through the full update either.
    const full = await request(app).put(`/api/events/${ev.eventId}/full`).set(headersFor(org.admin)).send({ tickets: [] });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('TICKET_TYPE_HAS_SALES');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isArchived).toBe(false);

    const hidden = await updateType(org.admin, ev.eventId, ticketId, { status: 'HIDDEN' });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toMatchObject({ status: 'HIDDEN', soldCount: 3, hasSales: true });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isAvailable).toBe(false);
  }, 60000);

  it("the quantity can't go below what's sold", async () => {
    const { org, ev, ticketId } = await sold();
    const below = await updateType(org.admin, ev.eventId, ticketId, { quantity: 2 });
    expect(below.status).toBe(422);
    expect(below.body).toMatchObject({ code: 'TICKET_QUANTITY_BELOW_SOLD', message: "3 'Saturday' tickets have already been sold, so there can't be fewer than 3." });
    expect((await updateType(org.admin, ev.eventId, ticketId, { quantity: 3 })).status).toBe(200);
  }, 60000);

  it("the days it admits can't change; the price can (for future sales)", async () => {
    const { org, ev, ticketId } = await sold();
    for (const admittedDayIds of [null, [ev.dayIds[0]], [ev.dayIds[0], ev.dayIds[1]]]) {
      const res = await updateType(org.admin, ev.eventId, ticketId, { admittedDayIds });
      expect(res.status, JSON.stringify(admittedDayIds)).toBe(409);
      expect(res.body.code).toBe('TICKET_ADMITTED_DAYS_LOCKED');
    }
    // Re-sending the same days is no change.
    expect((await updateType(org.admin, ev.eventId, ticketId, { admittedDayIds: [ev.dayIds[1]] })).status).toBe(200);
    const repriced = await updateType(org.admin, ev.eventId, ticketId, { priceCents: 25_000 });
    expect(repriced.status).toBe(200);
    expect(repriced.body.data.priceCents).toBe(25_000);
  }, 60000);

  it("a day it admits can't be removed, by DELETE or the full update; a day it doesn't admit can", async () => {
    const { org, ev, ticketId } = await sold();
    const del = await request(app).delete(`/api/events/${ev.eventId}/days/${ev.dayIds[1]}`).set(headersFor(org.admin));
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ code: 'EVENT_DAY_HAS_TICKET_SALES', message: "'Day 2' can't be removed: 'Saturday' tickets admit it and have been sold." });
    const full = await request(app).put(`/api/events/${ev.eventId}/full`).set(headersFor(org.admin)).send({ days: [{ id: ev.dayIds[0] }] });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('EVENT_DAY_HAS_TICKET_SALES');
    expect((await prisma.eventDay.findUniqueOrThrow({ where: { id: ev.dayIds[1]! } })).isArchived).toBe(false);

    // Day 1 isn't admitted by it: removable.
    expect((await request(app).delete(`/api/events/${ev.eventId}/days/${ev.dayIds[0]}`).set(headersFor(org.admin))).status).toBe(200);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isArchived).toBe(false);
  }, 60000);

  it('a type admitting every day, with sales, protects every day', async () => {
    const { org, ev } = await setup();
    const res = await createType(org.admin, ev.eventId);
    await simulateSale(res.body.data.id, 1);
    const del = await request(app).delete(`/api/events/${ev.eventId}/days/${ev.dayIds[0]}`).set(headersFor(org.admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('EVENT_DAY_HAS_TICKET_SALES');
  }, 60000);

  it("before a sale, a type's only day can't be removed until the type changes", async () => {
    const { org, ev } = await setup();
    const res = await createType(org.admin, ev.eventId, { name: 'Saturday', admittedDayIds: [ev.dayIds[1]] });
    const del = await request(app).delete(`/api/events/${ev.eventId}/days/${ev.dayIds[1]}`).set(headersFor(org.admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('EVENT_DAY_ONLY_TICKET_DAY');
    // In one full update: the type moves to Day 1 and Day 2 goes.
    const full = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(headersFor(org.admin))
      .send({ days: [{ id: ev.dayIds[0] }], tickets: [{ id: res.body.data.id, admittedDayIds: [ev.dayIds[0]] }] });
    expect(full.status).toBe(200);
    expect(await prisma.ticketAdmittedDay.findMany({ where: { ticketId: res.body.data.id } })).toEqual([
      expect.objectContaining({ eventDayId: ev.dayIds[0] }),
    ]);
  }, 60000);
});

describe('who', () => {
  it('event admins of the event; a locked member only on their assigned events; another tenant never', async () => {
    const { org, ev } = await setup();
    const other = await createTicketedEvent(org);
    // An Event Admin with no assignments sees every event of the tenant.
    expect((await createType(org.eventAdmin, ev.eventId)).status).toBe(201);
    // Once assigned to another event, this one is a 404.
    await assign(org.tenantId, org.eventAdmin.id, other.eventId, org.admin.id);
    expect((await createType(org.eventAdmin, ev.eventId, { name: 'Locked out' })).status).toBe(404);
    expect((await request(app).get(ticketsUrl(ev.eventId)).set(headersFor(org.eventAdmin))).status).toBe(404);
    expect((await createType(org.eventAdmin, other.eventId)).status).toBe(201);

    const stranger = await createOrg();
    expect((await createType(stranger.admin, ev.eventId)).status).toBe(404);
    expect((await request(app).get(ticketsUrl(ev.eventId))).status).toBe(401);
  }, 60000);

  it('the organiser list is in order, with sold counts and what is left', async () => {
    const { org, ev } = await setup();
    const b = await createType(org.admin, ev.eventId, { name: 'B', sortOrder: 2 });
    await createType(org.admin, ev.eventId, { name: 'A', sortOrder: 1 });
    await simulateSale(b.body.data.id, 5, 2);
    const list = await request(app).get(ticketsUrl(ev.eventId)).set(headersFor(org.admin));
    expect(list.body.data.map((t: { name: string }) => t.name)).toEqual(['A', 'B']);
    expect(list.body.data[1]).toMatchObject({ quantity: VALID_TYPE.quantity, soldCount: 5, remaining: VALID_TYPE.quantity - 7, hasSales: true });
  }, 60000);
});
