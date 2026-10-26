import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import {
  createTenant,
  createActor,
  assign,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  PUT /api/events/:eventId/full — the wizard's edit mode, all or nothing
//
//  A seeded event (three days, three program items, two custom questions,
//  two ticket types, a Memory Hub) is edited in one request. A valid edit
//  lands whole; any refusal leaves every row exactly as it was (compared
//  row by row, updatedAt included); removed rows are archived, never
//  deleted; and the event lookup's scoping and assignment lock hold.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let savedElevate: SubscriptionTierConfig | null = null;
let owner: Actor;
let outsider: Actor;
let lockedMember: Actor;

beforeAll(async () => {
  // The fixtures' ELEVATE plan has custom questions (other suites change
  // the shared tier rows; restored after).
  savedElevate = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'ELEVATE' },
    create: { tier: 'ELEVATE', customRsvpFieldsEnabled: true },
    update: { customRsvpFieldsEnabled: true },
  });
  const tenant = await createTenant();
  const other = await createTenant();
  tenantIds.push(tenant.id, other.id);
  owner = await createActor('TENANT_ADMIN', tenant.id);
  outsider = await createActor('TENANT_ADMIN', other.id);
  lockedMember = await createActor('EVENT_ADMIN', tenant.id);
  // Assigned to some other event, so locked out of every seeded one.
  const { event } = await createEventWithDay(tenant.id, owner.id);
  await assign(tenant.id, lockedMember.id, event.id, owner.id);
}, 60000);

beforeEach(() => installFirebaseMock());

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
  if (savedElevate) {
    // The whole saved row, updatedAt included: back exactly as found.
    const { tier: _tier, ...values } = savedElevate;
    await prisma.subscriptionTierConfig.upsert({ where: { tier: 'ELEVATE' }, create: savedElevate, update: values });
  } else {
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'ELEVATE' } });
  }
  await prisma.$disconnect();
}, 60000);

const url = (eventId: string) => `/api/events/${eventId}/full`;

interface Seeded {
  eventId: string;
  days: string[];
  items: string[];
  fields: string[];
  tickets: string[];
  hubId: string;
  programId: string;
}

const seed = async (): Promise<Seeded> => {
  const by = owner.id;
  const tenantId = owner.tenantId!;
  const event = await prisma.event.create({
    data: { tenantId, createdByUserId: by, name: 'Original name', hostName: 'Original Host', status: 'PUBLISHED', createdBy: by, updatedBy: by },
  });
  const hub = await prisma.memoryHub.create({ data: { eventId: event.id, isPublic: false, createdBy: by, updatedBy: by } });
  const days = [];
  for (const [i, date] of ['2027-03-01', '2027-03-02', '2027-03-03'].entries()) {
    days.push(
      await prisma.eventDay.create({
        data: { eventId: event.id, label: `Day ${i + 1}`, date: new Date(date), location: 'Hall', address: '1 Main Rd', createdBy: by, updatedBy: by },
      })
    );
  }
  const program = await prisma.eventProgram.create({ data: { eventId: event.id, title: 'Program', isPublished: true, createdBy: by, updatedBy: by } });
  const items = [];
  for (const [i, day] of days.entries()) {
    items.push(
      await prisma.programItem.create({
        data: {
          programId: program.id,
          eventDayId: day.id,
          title: `Item ${i + 1}`,
          startTime: new Date(`2027-03-0${i + 1}T10:00:00Z`),
          order: i,
          createdBy: by,
          updatedBy: by,
        },
      })
    );
  }
  const fields = [];
  for (const [i, label] of ['Dietary needs', 'Song request'].entries()) {
    fields.push(await prisma.rsvpField.create({ data: { eventId: event.id, label, fieldType: 'TEXT', order: i, createdBy: by, updatedBy: by } }));
  }
  const tickets = [];
  for (const name of ['General', 'VIP']) {
    tickets.push(await prisma.ticket.create({ data: { eventId: event.id, name, price: 100, createdBy: by, updatedBy: by } }));
  }
  return {
    eventId: event.id,
    days: days.map((d) => d.id),
    items: items.map((i) => i.id),
    fields: fields.map((f) => f.id),
    tickets: tickets.map((t) => t.id),
    hubId: hub.id,
    programId: program.id,
  };
};

// Every row the endpoint could touch, archived ones included, updatedAt
// included: equal snapshots mean nothing was written.
const snapshot = async (eventId: string) =>
  JSON.stringify({
    event: await prisma.event.findUnique({ where: { id: eventId } }),
    days: await prisma.eventDay.findMany({ where: { eventId }, orderBy: { id: 'asc' } }),
    program: await prisma.eventProgram.findMany({ where: { eventId } }),
    items: await prisma.programItem.findMany({ where: { program: { eventId } }, orderBy: { id: 'asc' } }),
    fields: await prisma.rsvpField.findMany({ where: { eventId }, orderBy: { id: 'asc' } }),
    tickets: await prisma.ticket.findMany({ where: { eventId }, orderBy: { id: 'asc' } }),
    hub: await prisma.memoryHub.findMany({ where: { eventId } }),
  });

// The edit a real organiser makes: rename, move Day 1 (and its item with
// it), add a day with an item on it, drop Day 3 and its item, reorder and
// replace questions, change and replace ticket types, hide the program and
// set the album's opening.
const fullEdit = (s: Seeded) => ({
  event: { name: 'Renamed', hostName: '  Thandi & Sipho ', capacity: 250, rsvpDeadline: '2027-02-20T23:59:59', description: null },
  days: [
    { id: s.days[0], label: 'Ceremony', date: '2027-03-05', location: 'Chapel', address: '2 Church St' },
    { id: s.days[1] },
    { label: 'Brunch', date: '2027-03-06', location: 'Cafe', address: '3 Beach Rd', latitude: -33.9, longitude: 18.4 },
  ],
  tickets: [{ id: s.tickets[0], name: 'General admission', price: 150 }, { name: 'Early bird', price: 80, totalQuantity: 20 }],
  rsvpFields: [{ id: s.fields[1], label: 'Song request' }, { label: 'Shirt size', fieldType: 'DROPDOWN', options: '["S","M","L"]', isRequired: true }],
  program: {
    title: 'Order of the day',
    isPublished: false,
    items: [
      { id: s.items[0], title: 'Vows', startTime: '2027-03-05T10:00:00', dayIndex: 0 },
      { id: s.items[1] },
      { title: 'Pancakes', startTime: '2027-03-06T09:00:00', dayIndex: 2, durationMins: 45 },
    ],
  },
  memoryHub: { opensAt: '2027-03-05T18:00:00' },
});

describe('a valid full update applies everything', () => {
  it('writes every part, archives what was removed, and answers with the event detail', async () => {
    const s = await seed();
    const before = await prisma.eventDay.findUnique({ where: { id: s.days[1]! } });

    const res = await request(app).put(url(s.eventId)).set(headersFor(owner)).send(fullEdit(s));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // GET /api/events/:id's shape: the event with its parts, plus guest counts.
    expect(res.body.data).toMatchObject({ id: s.eventId, name: 'Renamed', guestLimit: expect.any(Object), acceptedGuestCount: 0 });
    expect(res.body.data.eventDays.map((d: { label: string }) => d.label)).toEqual(['Day 2', 'Ceremony', 'Brunch']);

    const event = await prisma.event.findUniqueOrThrow({ where: { id: s.eventId } });
    expect(event).toMatchObject({ name: 'Renamed', hostName: 'Thandi & Sipho', capacity: 250, description: null });
    expect(event.rsvpDeadline?.toISOString()).toBe('2027-02-20T23:59:59.000Z');

    const days = await prisma.eventDay.findMany({ where: { eventId: s.eventId } });
    const day = (id: string) => days.find((d) => d.id === id)!;
    expect(day(s.days[0]!)).toMatchObject({ label: 'Ceremony', location: 'Chapel', isArchived: false });
    expect(day(s.days[0]!).date.toISOString()).toBe('2027-03-05T00:00:00.000Z');
    // Sent with only its id: nothing about it changed, so it wasn't written.
    expect(day(s.days[1]!).updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    const brunch = days.find((d) => d.label === 'Brunch')!;
    expect(brunch).toMatchObject({ isArchived: false, location: 'Cafe' });
    expect(Number(brunch.latitude)).toBeCloseTo(-33.9);

    const items = await prisma.programItem.findMany({ where: { programId: s.programId } });
    const item = (id: string) => items.find((i) => i.id === id)!;
    expect(item(s.items[0]!)).toMatchObject({ title: 'Vows', eventDayId: s.days[0], order: 0 });
    expect(item(s.items[0]!).startTime.toISOString()).toBe('2027-03-05T10:00:00.000Z');
    expect(item(s.items[1]!)).toMatchObject({ title: 'Item 2', order: 1, isArchived: false });
    const pancakes = items.find((i) => i.title === 'Pancakes')!;
    expect(pancakes).toMatchObject({ eventDayId: brunch.id, order: 2, durationMins: 45 });

    const program = await prisma.eventProgram.findUniqueOrThrow({ where: { id: s.programId } });
    expect(program).toMatchObject({ title: 'Order of the day', isPublished: false });

    const fields = await prisma.rsvpField.findMany({ where: { eventId: s.eventId } });
    expect(fields.find((f) => f.id === s.fields[1])).toMatchObject({ order: 0, isArchived: false });
    expect(fields.find((f) => f.label === 'Shirt size')).toMatchObject({ order: 1, fieldType: 'DROPDOWN', isRequired: true, options: '["S","M","L"]' });

    const tickets = await prisma.ticket.findMany({ where: { eventId: s.eventId } });
    expect(tickets.find((t) => t.id === s.tickets[0])).toMatchObject({ name: 'General admission', isArchived: false });
    expect(Number(tickets.find((t) => t.id === s.tickets[0])!.price)).toBe(150);
    expect(tickets.find((t) => t.name === 'Early bird')).toMatchObject({ totalQuantity: 20, isArchived: false });

    const hub = await prisma.memoryHub.findUniqueOrThrow({ where: { id: s.hubId } });
    expect(hub.opensAt?.toISOString()).toBe('2027-03-05T18:00:00.000Z');
  }, 60000);

  it('removed children are archived, not deleted', async () => {
    const s = await seed();
    const res = await request(app).put(url(s.eventId)).set(headersFor(owner)).send(fullEdit(s));
    expect(res.status).toBe(200);

    // Still there, archived — every one restorable.
    expect(await prisma.eventDay.findUnique({ where: { id: s.days[2]! } })).toMatchObject({ isArchived: true, label: 'Day 3' });
    expect(await prisma.programItem.findUnique({ where: { id: s.items[2]! } })).toMatchObject({ isArchived: true });
    expect(await prisma.rsvpField.findUnique({ where: { id: s.fields[0]! } })).toMatchObject({ isArchived: true });
    expect(await prisma.ticket.findUnique({ where: { id: s.tickets[1]! } })).toMatchObject({ isArchived: true });
    // And gone from what the organiser sees.
    const detail = await request(app).get(`/api/events/${s.eventId}`).set(headersFor(owner));
    expect(detail.body.data.eventDays.map((d: { id: string }) => d.id)).not.toContain(s.days[2]);
    expect(detail.body.data.program.programItems.map((i: { id: string }) => i.id)).not.toContain(s.items[2]);
  }, 60000);

  it('two days can swap labels in one save', async () => {
    const s = await seed();
    const res = await request(app)
      .put(url(s.eventId))
      .set(headersFor(owner))
      .send({ days: [{ id: s.days[0], label: 'Day 2' }, { id: s.days[1], label: 'Day 1' }, { id: s.days[2] }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await prisma.eventDay.findUniqueOrThrow({ where: { id: s.days[0]! } })).label).toBe('Day 2');
    expect((await prisma.eventDay.findUniqueOrThrow({ where: { id: s.days[1]! } })).label).toBe('Day 1');
  }, 60000);

  it('with nothing changed, nothing is written', async () => {
    const s = await seed();
    const before = await snapshot(s.eventId);
    const res = await request(app)
      .put(url(s.eventId))
      .set(headersFor(owner))
      .send({
        event: { name: 'Original name' },
        days: s.days.map((id) => ({ id })),
        program: { items: s.items.map((id) => ({ id })) },
        rsvpFields: s.fields.map((id) => ({ id })),
        tickets: s.tickets.map((id) => ({ id })),
      });
    expect(res.status).toBe(200);
    expect(await snapshot(s.eventId)).toBe(before);
  }, 60000);

  it('a cancelled event follows the per-part endpoints, which take edits', async () => {
    const s = await seed();
    await prisma.event.update({ where: { id: s.eventId }, data: { status: 'CANCELLED' } });
    const res = await request(app).put(url(s.eventId)).set(headersFor(owner)).send({ event: { name: 'Called off' } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
  }, 60000);
});

describe('one invalid part refuses the whole request and changes nothing', () => {
  // Each case is the valid edit above with one part spoiled; the refusal is
  // the part's own endpoint's, and every row is as it was.
  const cases: { name: string; spoil: (body: ReturnType<typeof fullEdit>, s: Seeded) => unknown; status: number; code?: string; message?: RegExp }[] = [
    {
      name: 'a program item with no title',
      spoil: (b) => ({ ...b, program: { ...b.program, items: [...b.program.items, { title: '  ', startTime: '2027-03-05T12:00:00', dayIndex: 0 }] } }),
      status: 422,
      message: /needs a title/,
    },
    {
      name: 'an item starting on another date than its day',
      spoil: (b) => ({ ...b, program: { ...b.program, items: [...b.program.items, { title: 'Late', startTime: '2027-03-07T01:00:00', dayIndex: 2 }] } }),
      status: 422,
      code: 'PROGRAM_ITEM_DATE_NOT_ON_DAY',
    },
    {
      name: "a day's date moved without its item",
      spoil: (b, s) => ({ ...b, program: { ...b.program, items: [{ id: s.items[0] }, ...b.program.items.slice(1)] } }),
      status: 422,
      code: 'PROGRAM_ITEM_DATE_NOT_ON_DAY',
    },
    {
      name: 'a new day in the past',
      spoil: (b) => ({ ...b, days: [...b.days, { label: 'Rehearsal', date: '2020-01-01', location: 'Hall', address: '1 Main Rd' }] }),
      status: 422,
      code: 'EVENT_DAY_DATE_IN_PAST',
    },
    { name: 'a day with no venue', spoil: (b) => ({ ...b, days: [...b.days, { label: 'Afters', date: '2027-03-07' }] }), status: 422, message: /venue name/ },
    { name: 'an impossible capacity', spoil: (b) => ({ ...b, event: { ...b.event, capacity: 0 } }), status: 422, code: 'EVENT_CAPACITY_INVALID' },
    { name: 'a deadline after the last day', spoil: (b) => ({ ...b, event: { ...b.event, rsvpDeadline: '2027-04-01T00:00:00' } }), status: 400, message: /last day/ },
    { name: "another event's day", spoil: (b) => ({ ...b, days: [{ id: 'not-this-events-day' }, ...b.days] }), status: 404, message: /Event day not found/ },
    { name: "an item that isn't this event's", spoil: (b) => ({ ...b, program: { ...b.program, items: [{ id: 'nope' }] } }), status: 404, message: /Program item not found/ },
    { name: 'two days with one label', spoil: (b) => ({ ...b, days: [...b.days, { label: 'brunch', date: '2027-03-07', location: 'Hall', address: '1 Main Rd' }] }), status: 409, message: /day labeled/ },
    { name: 'a ticket with no price', spoil: (b) => ({ ...b, tickets: [...b.tickets, { name: 'Free?' }] }), status: 422, message: /price/ },
    { name: 'a question with no answer type', spoil: (b) => ({ ...b, rsvpFields: [...b.rsvpFields, { label: 'Pick one' }] }), status: 422, message: /answer type/ },
    { name: 'a multi-day item with no day', spoil: (b) => ({ ...b, program: { ...b.program, items: [...b.program.items, { title: 'Floating', startTime: '2027-03-05T12:00:00' }] } }), status: 422, message: /Choose the day/ },
    { name: 'a malformed list', spoil: (b) => ({ ...b, days: 'all of them' }), status: 400 },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const s = await seed();
      const before = await snapshot(s.eventId);
      const res = await request(app).put(url(s.eventId)).set(headersFor(owner)).send(c.spoil(fullEdit(s), s) as object);
      expect(res.status, JSON.stringify(res.body)).toBe(c.status);
      if (c.code) expect(res.body.code).toBe(c.code);
      if (c.message) expect(res.body.message).toMatch(c.message);
      expect(await snapshot(s.eventId)).toBe(before);
    }, 60000);
  }

  it('a refusal the database gives mid-save (a label an archived day still holds) rolls back what was already written', async () => {
    // The event row and Day 3's archive are written before the new day
    // trips the (eventId, label) index, which counts archived days, as
    // POST .../days does after a DELETE.
    const s = await seed();
    const before = await snapshot(s.eventId);
    const body = fullEdit(s);
    body.days[2] = { ...body.days[2], label: 'Day 3' } as (typeof body.days)[number];
    body.program.items = body.program.items.slice(0, 2);
    const res = await request(app).put(url(s.eventId)).set(headersFor(owner)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.message).toMatch(/day labeled 'Day 3'/);
    expect(await snapshot(s.eventId)).toBe(before);
  }, 60000);

  it('with ticketing off, a ticket change is refused before anything is written', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    const s = await seed();
    const before = await snapshot(s.eventId);
    const res = await request(app).put(url(s.eventId)).set(headersFor(owner)).send(fullEdit(s));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Selling tickets isn't available/);
    expect(await snapshot(s.eventId)).toBe(before);
    // The same tickets sent back unchanged are fine.
    const ok = await request(app).put(url(s.eventId)).set(headersFor(owner)).send({ event: { name: 'Fine' }, tickets: s.tickets.map((id) => ({ id })) });
    expect(ok.status).toBe(200);
  }, 60000);

  it('a new custom question on a plan without them is the tier refusal, and nothing is written', async () => {
    const saved = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'SPARK' } });
    await prisma.subscriptionTierConfig.upsert({ where: { tier: 'SPARK' }, create: { tier: 'SPARK', customRsvpFieldsEnabled: false }, update: { customRsvpFieldsEnabled: false } });
    await prisma.tenant.update({ where: { id: owner.tenantId! }, data: { subscriptionTier: 'SPARK' } });
    try {
      const s = await seed();
      const before = await snapshot(s.eventId);
      const res = await request(app).put(url(s.eventId)).set(headersFor(owner)).send({ event: { name: 'X' }, rsvpFields: [{ label: 'New', fieldType: 'TEXT' }] });
      expect(res.status).toBe(403);
      expect(await snapshot(s.eventId)).toBe(before);
    } finally {
      await prisma.tenant.update({ where: { id: owner.tenantId! }, data: { subscriptionTier: 'ELEVATE' } });
      if (saved) {
        const { tier: _t, ...values } = saved;
        await prisma.subscriptionTierConfig.upsert({ where: { tier: 'SPARK' }, create: saved, update: values });
      } else {
        await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'SPARK' } });
      }
    }
  }, 60000);
});

describe('scoping', () => {
  it("another tenant's event is a 404 and nothing is written", async () => {
    const s = await seed();
    const before = await snapshot(s.eventId);
    const res = await request(app).put(url(s.eventId)).set(headersFor(outsider)).send(fullEdit(s));
    expect(res.status).toBe(404);
    expect(await snapshot(s.eventId)).toBe(before);
  }, 60000);

  it("a locked member's unassigned event is a 404 and nothing is written", async () => {
    const s = await seed();
    const before = await snapshot(s.eventId);
    const res = await request(app).put(url(s.eventId)).set(headersFor(lockedMember)).send(fullEdit(s));
    expect(res.status).toBe(404);
    expect(await snapshot(s.eventId)).toBe(before);
  }, 60000);
});
