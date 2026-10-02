import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  EVENT DAY — the day must belong to the :eventId in the URL
//
//  GET/PUT/DELETE /api/events/:eventId/days/:id used to ignore :eventId:
//  the tenant gate ran on the DAY's own event, so a day was reachable
//  under any other event's URL in the same tenant. Now a day reached under
//  the wrong event is the same 404 as a missing one (program-item already
//  works this way), and nothing about it changes. The right URL still works.
// ─────────────────────────────────────────

let owner: { id: string; firebaseUid: string; email: string; tenantId: string };
let eventId: string;
let otherEventId: string;
let dayId: string;
let headers: Record<string, string>;

beforeAll(async () => {
  const tenant = await createTestTenant();
  const u = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  owner = { id: u.id, firebaseUid: u.firebaseUid, email: u.email, tenantId: tenant.id };
  eventId = (await createTestEvent(tenant.id, u.id)).id;
  otherEventId = (await createTestEvent(tenant.id, u.id)).id;
  dayId = (await createTestEventDay(eventId, u.id, 'Ceremony')).id;
  const session = jwt.sign(
    { userId: u.id, firebaseUid: u.firebaseUid, email: u.email, role: 'TENANT_ADMIN', tenantId: tenant.id },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  headers = { Authorization: 'Bearer day-url-scope', 'X-Session-Token': session };
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async () => ({ uid: owner.firebaseUid }));
});

afterAll(async () => {
  for (const id of [eventId, otherEventId]) {
    await prisma.eventDay.deleteMany({ where: { eventId: id } });
    await deleteTestEvent(id);
  }
  await deleteTestUserRow(owner.id);
  await deleteTestTenant(owner.tenantId);
  await prisma.$disconnect();
}, 60000);

describe('event day — scoped to the URL\'s event', () => {
  it("a day under another event's URL is a 404 on GET, PUT and DELETE, and is unchanged", async () => {
    const wrong = `/api/events/${otherEventId}/days/${dayId}`;
    expect((await request(app).get(wrong).set(headers)).status).toBe(404);
    expect((await request(app).put(wrong).set(headers).send({ label: 'Moved' })).status).toBe(404);
    expect((await request(app).delete(wrong).set(headers)).status).toBe(404);

    const day = await prisma.eventDay.findUniqueOrThrow({ where: { id: dayId } });
    expect(day).toMatchObject({ eventId, label: 'Ceremony', isArchived: false });
  }, 60000);

  it('under its own event the same day still works', async () => {
    const right = `/api/events/${eventId}/days/${dayId}`;
    const get = await request(app).get(right).set(headers);
    expect(get.status).toBe(200);
    expect(get.body.data.id).toBe(dayId);
    const put = await request(app).put(right).set(headers).send({ label: 'Vows' });
    expect(put.status).toBe(200);
    expect(put.body.data.label).toBe('Vows');
  }, 60000);
});
