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
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  TICKETS AND CUSTOM RSVP FIELDS — tenant scoping through the event
//
//  /api/events/:eventId/tickets and /rsvp-fields did no scoping at all:
//  any EVENT_ADMIN could read, edit or archive any event's tickets and
//  custom questions by id, both ticket reads were unauthenticated, a
//  missing id was a bare-Error 500, and the SPARK "no custom RSVP fields"
//  gate could be skipped by adding a field here instead of through the
//  wizard. Asserts: another tenant's records are a 404 on every read and
//  write (and nothing changes); a record reached under the wrong :eventId
//  of the SAME tenant is a 404 too; ticket reads need an organiser; a
//  missing id is a 404, not a 500; SPARK cannot add a custom field here.
// ─────────────────────────────────────────

type Actor = { id: string; firebaseUid: string; email: string; role: 'TENANT_ADMIN' | 'EVENT_ADMIN'; tenantId: string };
const tokens = new Map<string, string>();
const headersFor = (actor: Actor) => {
  const firebaseToken = `ticket-field-scope-${actor.id}`;
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
let siblingEventId: string; // same tenant, different event
let ticketId: string;
let fieldId: string;

beforeAll(async () => {
  const t1 = await createTestTenant();
  const t2 = await createTestTenant();
  const u1 = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: t1.id });
  const u2 = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: t2.id });
  owner = { id: u1.id, firebaseUid: u1.firebaseUid, email: u1.email, role: 'TENANT_ADMIN', tenantId: t1.id };
  outsider = { id: u2.id, firebaseUid: u2.firebaseUid, email: u2.email, role: 'EVENT_ADMIN', tenantId: t2.id };
  eventId = (await createTestEvent(t1.id, u1.id)).id;
  siblingEventId = (await createTestEvent(t1.id, u1.id)).id;
  ticketId = (
    await prisma.ticket.create({
      data: { eventId, name: 'General', price: 150, currency: 'ZAR', createdBy: u1.id, updatedBy: u1.id },
    })
  ).id;
  fieldId = (
    await prisma.rsvpField.create({
      data: { eventId, label: 'Dietary needs', fieldType: 'TEXT', order: 0, createdBy: u1.id, updatedBy: u1.id },
    })
  ).id;
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens.get(token);
    if (uid) return { uid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
});

afterAll(async () => {
  for (const id of [eventId, siblingEventId]) {
    await prisma.ticket.deleteMany({ where: { eventId: id } });
    await prisma.rsvpField.deleteMany({ where: { eventId: id } });
    await deleteTestEvent(id);
  }
  await deleteTestUserRow(owner.id);
  await deleteTestUserRow(outsider.id);
  await prisma.tenant.update({ where: { id: owner.tenantId }, data: { subscriptionTier: 'SPARK' } });
  await deleteTestTenant(owner.tenantId);
  await deleteTestTenant(outsider.tenantId);
  await prisma.$disconnect();
}, 60000);

const ticketsUrl = (id: string) => `/api/events/${id}/tickets`;
const fieldsUrl = (id: string) => `/api/events/${id}/rsvp-fields`;

describe('tickets — scoped through the event', () => {
  it("another tenant's tickets: 404 on list, read, create, update and archive; nothing changes", async () => {
    const h = headersFor(outsider);
    expect((await request(app).get(ticketsUrl(eventId)).set(h)).status).toBe(404);
    expect((await request(app).get(`${ticketsUrl(eventId)}/${ticketId}`).set(h)).status).toBe(404);
    expect((await request(app).post(ticketsUrl(eventId)).set(h).send({ name: 'Free for all', price: 0 })).status).toBe(404);
    expect((await request(app).put(`${ticketsUrl(eventId)}/${ticketId}`).set(h).send({ price: 1 })).status).toBe(404);
    expect((await request(app).delete(`${ticketsUrl(eventId)}/${ticketId}`).set(h)).status).toBe(404);

    const tickets = await prisma.ticket.findMany({ where: { eventId } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ id: ticketId, name: 'General', isArchived: false });
    expect(Number(tickets[0]!.price)).toBe(150);
  }, 60000);

  it('the owner reaches them; under a sibling event\'s URL the same ticket is a 404', async () => {
    const h = headersFor(owner);
    const list = await request(app).get(ticketsUrl(eventId)).set(h);
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([ticketId]);
    expect((await request(app).get(`${ticketsUrl(eventId)}/${ticketId}`).set(h)).status).toBe(200);

    expect((await request(app).get(`${ticketsUrl(siblingEventId)}/${ticketId}`).set(h)).status).toBe(404);
    expect((await request(app).put(`${ticketsUrl(siblingEventId)}/${ticketId}`).set(h).send({ price: 1 })).status).toBe(404);
    expect((await request(app).delete(`${ticketsUrl(siblingEventId)}/${ticketId}`).set(h)).status).toBe(404);
  }, 60000);

  it('reads are no longer public, and a missing id is a 404 rather than a 500', async () => {
    expect((await request(app).get(ticketsUrl(eventId))).status).toBe(401);
    expect((await request(app).get(`${ticketsUrl(eventId)}/${ticketId}`)).status).toBe(401);
    const missing = await request(app).get(`${ticketsUrl(eventId)}/does-not-exist`).set(headersFor(owner));
    expect(missing.status).toBe(404);
  }, 60000);
});

describe('custom RSVP fields — scoped through the event, tier gate enforced', () => {
  it("another tenant's fields: 404 on list, read, create, update and archive; nothing changes", async () => {
    const h = headersFor(outsider);
    expect((await request(app).get(fieldsUrl(eventId)).set(h)).status).toBe(404);
    expect((await request(app).get(`${fieldsUrl(eventId)}/${fieldId}`).set(h)).status).toBe(404);
    expect((await request(app).post(fieldsUrl(eventId)).set(h).send({ label: 'Injected', fieldType: 'TEXT', order: 1 })).status).toBe(404);
    expect((await request(app).put(`${fieldsUrl(eventId)}/${fieldId}`).set(h).send({ label: 'Hijacked' })).status).toBe(404);
    expect((await request(app).delete(`${fieldsUrl(eventId)}/${fieldId}`).set(h)).status).toBe(404);

    const fields = await prisma.rsvpField.findMany({ where: { eventId } });
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ id: fieldId, label: 'Dietary needs', isArchived: false });
  }, 60000);

  it("under a sibling event's URL the same field is a 404; a missing id is a 404, not a 500", async () => {
    const h = headersFor(owner);
    expect((await request(app).get(`${fieldsUrl(eventId)}/${fieldId}`).set(h)).status).toBe(200);
    expect((await request(app).get(`${fieldsUrl(siblingEventId)}/${fieldId}`).set(h)).status).toBe(404);
    expect((await request(app).put(`${fieldsUrl(siblingEventId)}/${fieldId}`).set(h).send({ label: 'X' })).status).toBe(404);
    expect((await request(app).delete(`${fieldsUrl(siblingEventId)}/${fieldId}`).set(h)).status).toBe(404);
    expect((await request(app).get(`${fieldsUrl(eventId)}/does-not-exist`).set(h)).status).toBe(404);
  }, 60000);

  it('SPARK cannot add a custom field here (403, nothing created); CELEBRATE can', async () => {
    const h = headersFor(owner);
    const body = { label: 'Song request', fieldType: 'TEXT', order: 1 };
    const refused = await request(app).post(fieldsUrl(eventId)).set(h).send(body);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/custom RSVP fields/);
    expect(await prisma.rsvpField.count({ where: { eventId, label: 'Song request' } })).toBe(0);

    await prisma.tenant.update({ where: { id: owner.tenantId }, data: { subscriptionTier: 'CELEBRATE', subscriptionStatus: 'ACTIVE' } });
    const allowed = await request(app).post(fieldsUrl(eventId)).set(h).send(body);
    expect(allowed.status).toBe(201);
  }, 60000);
});
