import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import {
  createTenant,
  createActor,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';
import { MAX_GUESTS_PER_EVENT } from '../../src/modules/guest/guest-ceiling.util.js';
import { createPublicEvent, register, view, cleanupPublicEventFixtures } from '../public-events/helpers.js';

// ─────────────────────────────────────────
//  SAFETY LIMITS — the hard ceiling of 5,000 guests per event
//
//  Real rows, not a stubbed constant: each event starts one short of the
//  ceiling (4,999 live guests, a quarter of them plus-ones, which count),
//  on a plan left unlimited, and every path that adds a guest is tried
//  against it: organiser add, import, restore, self-registration and
//  plus-ones at RSVP. The plan's own limit still comes first.
// ─────────────────────────────────────────

const ALMOST = MAX_GUESTS_PER_EVENT - 1;
let savedElevate: SubscriptionTierConfig | null = null;
const tenantIds: string[] = [];

// `count` live guests on the event, about a quarter of them plus-ones of
// the first: one createMany per 1,000 rows. No contact (the unique index is
// on email), which the database allows.
const fillGuests = async (eventId: string, count: number) => {
  const hostId = randomUUID();
  await prisma.guest.create({ data: { id: hostId, eventId, firstName: 'Filler host' } });
  const rows = Array.from({ length: count - 1 }, (_, i) => ({
    eventId,
    firstName: `Filler ${i}`,
    ...(i % 4 === 0 ? { hostGuestId: hostId } : {}),
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.guest.createMany({ data: rows.slice(i, i + 1000) });
  }
};

const liveGuests = (eventId: string) => prisma.guest.count({ where: { eventId, isArchived: false } });

let organiser: Actor;
let privateEventId: string;
let privateDayId: string;

beforeAll(async () => {
  savedElevate = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'ELEVATE' },
    create: { tier: 'ELEVATE', maxGuestsPerEvent: null },
    update: { maxGuestsPerEvent: null },
  });
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event, day } = await createEventWithDay(tenant.id, organiser.id);
  privateEventId = event.id;
  privateDayId = day.id;
  await fillGuests(privateEventId, ALMOST);
}, 120000);

afterAll(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
  await cleanupPublicEventFixtures();
  if (savedElevate) {
    const { tier: _tier, updatedAt: _updatedAt, ...values } = savedElevate;
    await prisma.subscriptionTierConfig.update({ where: { tier: 'ELEVATE' }, data: values });
  }
}, 120000);

const addGuest = () =>
  request(app)
    .post(`/api/events/${privateEventId}/guests`)
    .set(headersFor(organiser))
    .send({ firstName: 'New', email: `ceiling-${randomUUID()}@test.invalid`, eventDayIds: [privateDayId] });

const CEILING = { status: 'error', code: 'EVENT_GUEST_CEILING' };

describe('organiser paths, on a plan left unlimited', () => {
  it('add: the 5,000th guest is added, the 5,001st is 422 EVENT_GUEST_CEILING, counting plus-ones', async () => {
    installFirebaseMock();
    expect(await liveGuests(privateEventId)).toBe(ALMOST);
    const last = await addGuest();
    expect(last.status).toBe(201);

    const over = await addGuest();
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject(CEILING);
    expect(over.body.message).toBe(
      'An event can have at most 5,000 guests, plus-ones included. This event has 5,000, and this would add 1.'
    );
    expect(await liveGuests(privateEventId)).toBe(MAX_GUESTS_PER_EVENT);

    // Back to one short for the next test.
    await prisma.guest.update({ where: { id: last.body.data.id }, data: { isArchived: true } });
  }, 60000);

  it('restore: bringing back an archived guest past the ceiling is 422, and it stays archived', async () => {
    installFirebaseMock();
    const archived = await prisma.guest.findFirstOrThrow({ where: { eventId: privateEventId, isArchived: true } });
    const fill = await addGuest(); // 5,000 live
    expect(fill.status).toBe(201);

    const res = await request(app).post(`/api/guests/${archived.id}/reactivate`).set(headersFor(organiser));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject(CEILING);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: archived.id } })).isArchived).toBe(true);

    await prisma.guest.update({ where: { id: fill.body.data.id }, data: { isArchived: true } });
    const restored = await request(app).post(`/api/guests/${archived.id}/reactivate`).set(headersFor(organiser));
    expect(restored.status).toBe(200);
    await prisma.guest.update({ where: { id: archived.id }, data: { isArchived: true } });
  }, 60000);

  it('import: two rows on an event with room for one is 422 EVENT_GUEST_CEILING, and nothing is imported', async () => {
    installFirebaseMock();
    const csv = Buffer.from(
      `First Name,Surname,Email or Phone,Day,Plus-ones\nA,One,imp-${randomUUID()}@test.invalid,Day 1,0\nB,Two,imp-${randomUUID()}@test.invalid,Day 1,0\n`
    );
    const res = await request(app)
      .post(`/api/events/${privateEventId}/guests/import`)
      .set(headersFor(organiser))
      .attach('file', csv, { filename: 'guests.csv', contentType: 'text/csv' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject(CEILING);
    expect(res.body.message).toMatch(/there is room for 1 more/);
    expect(await liveGuests(privateEventId)).toBe(ALMOST);
  }, 60000);

  it("the plan's own limit comes first: on a 50-guest plan the refusal is the plan's 403, not the ceiling", async () => {
    installFirebaseMock();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: organiser.tenantId! } });
    await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: 'SPARK' } });
    const savedSpark = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'SPARK' } });
    await prisma.subscriptionTierConfig.upsert({
      where: { tier: 'SPARK' },
      create: { tier: 'SPARK', maxGuestsPerEvent: 50 },
      update: { maxGuestsPerEvent: 50 },
    });
    try {
      const res = await addGuest();
      expect(res.status).toBe(403);
      expect(res.body.code).toBeUndefined();
      expect(res.body.message).toMatch(/50 guest\(s\)/);
    } finally {
      await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: tenant.subscriptionTier } });
      if (savedSpark) {
        const { tier: _tier, updatedAt: _updatedAt, ...values } = savedSpark;
        await prisma.subscriptionTierConfig.update({ where: { tier: 'SPARK' }, data: values });
      }
    }
  }, 60000);
});

describe('guest paths', () => {
  it('RSVP: plus-ones that would pass the ceiling are 409 REGISTRATION_FULL with no number; fewer fit; the same party again is fine', async () => {
    installFirebaseMock();
    // The guest replying is one of the 4,999.
    const created = await addGuest(); // 5,000 live, then archive a filler to make room for exactly one plus-one
    expect(created.status).toBe(201);
    const filler = await prisma.guest.findFirstOrThrow({ where: { eventId: privateEventId, isArchived: false, firstName: { startsWith: 'Filler 1' } } });
    await prisma.guest.update({ where: { id: filler.id }, data: { isArchived: true } });
    await prisma.guest.update({ where: { id: created.body.data.id }, data: { plusOnesAllowed: 3 } });
    const { token } = await prisma.invite.findFirstOrThrow({ where: { guestId: created.body.data.id } });
    const submit = (plusOneNames: string[]) =>
      request(app).post('/api/rsvp/submit').send({ token, attending: true, attendingDayIds: [privateDayId], plusOneNames });

    const tooMany = await submit(['Lebo', 'Sipho']);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body).toEqual({
      status: 'error',
      message: "This event is full, so there isn't room for your plus-ones. Please remove some and try again.",
      code: 'REGISTRATION_FULL',
    });
    expect(await prisma.guest.count({ where: { hostGuestId: created.body.data.id } })).toBe(0);

    expect((await submit(['Lebo'])).status).toBe(200);
    expect(await liveGuests(privateEventId)).toBe(MAX_GUESTS_PER_EVENT);
    // Editing with the same one plus-one archives and recreates it: never refused.
    expect((await submit(['Lebo'])).status).toBe(200);
    // Declining frees the seat again.
    expect((await request(app).post('/api/rsvp/submit').send({ token, attending: false })).status).toBe(200);
  }, 60000);

  it('self-registration: a party past the ceiling is PARTY_TOO_LARGE, the last seat registers, then FULL, in the view too', async () => {
    const ev = await createPublicEvent({ event: { registrationPlusOnesAllowed: 2 } });
    await fillGuests(ev.eventId, ALMOST);

    const tooBig = await register(ev.shareToken, { plusOneNames: ['Lebo'] });
    expect(tooBig.status).toBe(409);
    expect(tooBig.body.code).toBe('REGISTRATION_PARTY_TOO_LARGE');
    expect(tooBig.body.message).not.toMatch(/5,?000/);

    expect((await register(ev.shareToken, {})).status).toBe(201);
    expect(await liveGuests(ev.eventId)).toBe(MAX_GUESTS_PER_EVENT);

    const full = await register(ev.shareToken, {});
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('REGISTRATION_FULL');

    const page = await view(ev.shareToken);
    expect(page.body.data.registration).toMatchObject({ isOpen: false, reason: 'FULL' });
  }, 120000);
});
