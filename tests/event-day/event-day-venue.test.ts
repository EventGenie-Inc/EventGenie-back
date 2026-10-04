import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  THE VENUE BELONGS TO THE EVENT DAY — organiser endpoints, over HTTP
//
//  Every day has its own venue (event-day-venue.util.ts): a day cannot be
//  created or left without a venue name and address (422), coordinates are
//  both-or-neither and go stale with the address, another tenant's day is
//  a 404, and the event itself no longer takes a venue. Also covers the
//  event's own required name and hostName normalisation (items 5 and 6 of
//  the stabilisation batch). Real app, real test database; Firebase's
//  verifyIdToken stubbed (tests/setup.ts), session JWT signed here.
// ─────────────────────────────────────────

type Actor = { id: string; firebaseUid: string; email: string; role: 'TENANT_ADMIN' | 'EVENT_ADMIN'; tenantId: string };
const tokens = new Map<string, string>();

const headersFor = (actor: Actor) => {
  const firebaseToken = `day-venue-${actor.id}`;
  tokens.set(firebaseToken, actor.firebaseUid);
  const session = jwt.sign(
    { userId: actor.id, firebaseUid: actor.firebaseUid, email: actor.email, role: actor.role, tenantId: actor.tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${firebaseToken}`, 'X-Session-Token': session };
};

let owner: Actor;
let outsider: Actor;
let eventId: string;
const createdEventIds: string[] = [];

const VENUE = { location: 'Lourensford Estate', address: '1 Main Rd, Somerset West', latitude: -34.07, longitude: 18.89 };
const daysUrl = (id: string) => `/api/events/${id}/days`;

beforeAll(async () => {
  const t1 = await createTestTenant();
  const t2 = await createTestTenant();
  const u1 = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: t1.id });
  const u2 = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: t2.id });
  owner = { id: u1.id, firebaseUid: u1.firebaseUid, email: u1.email, role: 'TENANT_ADMIN', tenantId: t1.id };
  outsider = { id: u2.id, firebaseUid: u2.firebaseUid, email: u2.email, role: 'EVENT_ADMIN', tenantId: t2.id };
  eventId = (await createTestEvent(t1.id, u1.id)).id;
  // Back to DRAFT so publish can be exercised below.
  await eventRepository.updateStatus(eventId, u1.id, 'DRAFT');
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens.get(token);
    if (uid) return { uid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
});

afterAll(async () => {
  for (const id of [eventId, ...createdEventIds]) {
    await prisma.eventDay.deleteMany({ where: { eventId: id } });
    await deleteTestEvent(id);
  }
  await deleteTestUserRow(owner.id);
  await deleteTestUserRow(outsider.id);
  await deleteTestTenant(owner.tenantId);
  await deleteTestTenant(outsider.tenantId);
  await prisma.$disconnect();
}, 60000);

describe('event day venue — required on create', () => {
  it('a day without a venue name or address is 422, and nothing is saved', async () => {
    const h = headersFor(owner);
    const cases = [
      { label: 'No venue', date: '2027-04-01' },
      { label: 'Blank name', date: '2027-04-01', location: '   ', address: VENUE.address },
      { label: 'Blank address', date: '2027-04-01', location: VENUE.location, address: '' },
    ];
    for (const body of cases) {
      const res = await request(app).post(daysUrl(eventId)).set(h).send(body);
      expect(res.status, body.label).toBe(422);
      expect(res.body.message).toMatch(/venue (name|address)/);
    }
    expect(await prisma.eventDay.count({ where: { eventId, label: { in: cases.map((c) => c.label) } } })).toBe(0);
  }, 60000);

  it('a blank label or missing date is 422 (item 5)', async () => {
    const h = headersFor(owner);
    const blankLabel = await request(app).post(daysUrl(eventId)).set(h).send({ label: ' ', date: '2027-04-01', ...VENUE });
    expect(blankLabel.status).toBe(422);
    const noDate = await request(app).post(daysUrl(eventId)).set(h).send({ label: 'Undated', ...VENUE });
    expect(noDate.status).toBe(422);
    expect(noDate.body.message).toMatch(/needs a date/);
  }, 60000);

  it('a day with a venue saves it, trimmed, with plain-number coordinates', async () => {
    const res = await request(app)
      .post(daysUrl(eventId))
      .set(headersFor(owner))
      .send({ label: 'Ceremony', date: '2027-04-01', ...VENUE, location: `  ${VENUE.location} ` });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ location: VENUE.location, address: VENUE.address, latitude: -34.07, longitude: 18.89 });
  }, 60000);

  it('half a coordinate pair is refused', async () => {
    const res = await request(app)
      .post(daysUrl(eventId))
      .set(headersFor(owner))
      .send({ label: 'Half pin', date: '2027-04-02', location: VENUE.location, address: VENUE.address, latitude: -34.07 });
    expect(res.status).toBe(400);
  }, 60000);
});

describe('event day venue — update', () => {
  it('blanking the venue is 422; changing the address without coordinates clears the stale ones', async () => {
    const h = headersFor(owner);
    const created = await request(app).post(daysUrl(eventId)).set(h).send({ label: 'Brunch', date: '2027-04-02', ...VENUE });
    const dayId = created.body.data.id as string;

    const blank = await request(app).put(`${daysUrl(eventId)}/${dayId}`).set(h).send({ address: '  ' });
    expect(blank.status).toBe(422);

    // A label-only edit keeps the stored venue — judged on the day it leaves behind.
    const renamed = await request(app).put(`${daysUrl(eventId)}/${dayId}`).set(h).send({ label: 'Farewell brunch' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ label: 'Farewell brunch', ...VENUE });

    const moved = await request(app).put(`${daysUrl(eventId)}/${dayId}`).set(h).send({ address: '9 Other St, Stellenbosch' });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ location: VENUE.location, address: '9 Other St, Stellenbosch', latitude: null, longitude: null });
  }, 60000);

  it("another tenant's day is a 404 on update, and the day is unchanged", async () => {
    const created = await request(app)
      .post(daysUrl(eventId))
      .set(headersFor(owner))
      .send({ label: 'Reception', date: '2027-04-03', ...VENUE });
    const dayId = created.body.data.id as string;

    const res = await request(app)
      .put(`${daysUrl(eventId)}/${dayId}`)
      .set(headersFor(outsider))
      .send({ location: 'Hijacked Hall', address: '1 Evil Rd' });
    expect(res.status).toBe(404);

    const after = await prisma.eventDay.findUniqueOrThrow({ where: { id: dayId } });
    expect(after.location).toBe(VENUE.location);
    expect(after.address).toBe(VENUE.address);
  }, 60000);
});

describe('event — the venue is no longer the event\'s', () => {
  it('create ignores an event-level venue, requires a name, and stores a blank hostName as null', async () => {
    const h = headersFor(owner);
    const noName = await request(app).post('/api/events').set(h).send({ hostName: 'X' });
    expect(noName.status).toBe(422);
    expect(noName.body.message).toMatch(/needs a name/);

    const res = await request(app)
      .post('/api/events')
      .set(h)
      .send({ name: 'Venue-less event', location: 'Old Venue', address: 'Old Address', latitude: 1, longitude: 1, hostName: '   ' });
    expect(res.status).toBe(201);
    createdEventIds.push(res.body.data.id);
    const row = await prisma.event.findUniqueOrThrow({ where: { id: res.body.data.id } });
    // The Event has no venue columns any more; an old client's venue keys are
    // ignored, not refused, and never reach the row.
    expect(row.hostName).toBeNull();
    for (const key of ['location', 'address', 'latitude', 'longitude']) expect(row).not.toHaveProperty(key);
  }, 60000);

  it('update ignores an event-level venue, refuses a blank name, and trims hostName (blank → null)', async () => {
    const h = headersFor(owner);

    const blankName = await request(app).put(`/api/events/${eventId}`).set(h).send({ name: '  ' });
    expect(blankName.status).toBe(422);

    const trimmed = await request(app).put(`/api/events/${eventId}`).set(h).send({ hostName: '  Sarah & Tom ', location: 'Ignored' });
    expect(trimmed.status).toBe(200);
    let row = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.hostName).toBe('Sarah & Tom');
    expect(row).not.toHaveProperty('location');

    const blank = await request(app).put(`/api/events/${eventId}`).set(h).send({ hostName: '   ' });
    expect(blank.status).toBe(200);
    row = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.hostName).toBeNull();
  }, 60000);

  it('publish refuses an event with a day that has no venue (a pre-migration leftover)', async () => {
    const h = headersFor(owner);
    await prisma.eventDay.create({
      data: { eventId, label: 'Legacy day', date: new Date('2027-04-09'), isArchived: false, createdBy: owner.id, updatedBy: owner.id },
    });
    const res = await request(app).post(`/api/events/${eventId}/publish`).set(h).send();
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/a venue for 'Legacy day'/);
  }, 60000);
});
