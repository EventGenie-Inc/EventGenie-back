import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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

// ─────────────────────────────────────────
//  THE PLAN'S GUEST LIMIT — on restore, and under concurrent additions
//
//  Restoring an archived guest is held to the plan's own limit (it used to
//  check only the 5,000 ceiling); a plus-one, which the plan doesn't count,
//  still restores at the limit. Organiser add and import take the event's
//  row lock, as registration does, so two at once can't both take the last
//  place. The fixtures' plan (ELEVATE) is set to 3 guests per event and
//  put back afterwards.
// ─────────────────────────────────────────

const LIMIT = 3;
const tenantIds: string[] = [];
let savedElevate: SubscriptionTierConfig | null = null;
let organiser: Actor;

beforeAll(async () => {
  savedElevate = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'ELEVATE' },
    create: { tier: 'ELEVATE', maxGuestsPerEvent: LIMIT },
    update: { maxGuestsPerEvent: LIMIT },
  });
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

beforeEach(() => installFirebaseMock());

afterAll(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
  if (savedElevate) {
    const { tier: _tier, updatedAt: _updatedAt, ...values } = savedElevate;
    await prisma.subscriptionTierConfig.update({ where: { tier: 'ELEVATE' }, data: values });
  } else {
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'ELEVATE' } });
  }
  await prisma.$disconnect();
}, 60000);

// An event with `count` live primary guests (no contact: the unique index
// is on email, which the database allows).
const eventWithGuests = async (count: number) => {
  const { event, day } = await createEventWithDay(organiser.tenantId!, organiser.id);
  for (let i = 0; i < count; i++) await prisma.guest.create({ data: { eventId: event.id, firstName: `Guest ${i}` } });
  return { eventId: event.id, dayId: day.id };
};

const archivedGuest = (eventId: string, hostGuestId?: string) =>
  prisma.guest.create({ data: { eventId, firstName: 'Archived', isArchived: true, ...(hostGuestId && { hostGuestId }) } });

const liveCount = (eventId: string) => prisma.guest.count({ where: { eventId, isArchived: false } });

describe('restoring a guest checks the plan limit', () => {
  it('refuses a restore past the plan limit, and the guest stays archived', async () => {
    const { eventId } = await eventWithGuests(LIMIT);
    const guest = await archivedGuest(eventId);
    const res = await request(app).post(`/api/guests/${guest.id}/reactivate`).set(headersFor(organiser));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(new RegExp(`maximum of ${LIMIT} guest`));
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).isArchived).toBe(true);
  }, 60000);

  it('restores while there is room', async () => {
    const { eventId } = await eventWithGuests(LIMIT - 1);
    const guest = await archivedGuest(eventId);
    const res = await request(app).post(`/api/guests/${guest.id}/reactivate`).set(headersFor(organiser));
    expect(res.status).toBe(200);
    expect(await liveCount(eventId)).toBe(LIMIT);
  }, 60000);

  it("restores a plus-one at the limit: the plan's limit doesn't count plus-ones", async () => {
    const { eventId } = await eventWithGuests(LIMIT);
    const host = await prisma.guest.findFirstOrThrow({ where: { eventId } });
    const plusOne = await archivedGuest(eventId, host.id);
    const res = await request(app).post(`/api/guests/${plusOne.id}/reactivate`).set(headersFor(organiser));
    expect(res.status).toBe(200);
  }, 60000);
});

describe('additions are serialised per event', () => {
  it('two organiser adds racing for the last place: one is added, one refused', async () => {
    const { eventId, dayId } = await eventWithGuests(LIMIT - 1);
    const add = () =>
      request(app)
        .post(`/api/events/${eventId}/guests`)
        .set(headersFor(organiser))
        .send({ firstName: 'Racer', email: `racer-${randomUUID()}@test.invalid`, eventDayIds: [dayId] });
    const statuses = (await Promise.all([add(), add()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 403]);
    expect(await liveCount(eventId)).toBe(LIMIT);
  }, 60000);

  it('two imports racing for the last place: one imports, one is refused', async () => {
    const { eventId } = await eventWithGuests(LIMIT - 1);
    const csv = () =>
      Buffer.from(`First Name,Surname,Email or Phone,Day,Plus-ones\nImported,Guest,imp-${randomUUID()}@test.invalid,Day 1,0\n`);
    const importOne = () =>
      request(app)
        .post(`/api/events/${eventId}/guests/import`)
        .set(headersFor(organiser))
        .attach('file', csv(), { filename: 'guests.csv', contentType: 'text/csv' });
    const statuses = (await Promise.all([importOne(), importOne()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);
    expect(await liveCount(eventId)).toBe(LIMIT);
  }, 60000);
});
