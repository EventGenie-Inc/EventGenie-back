import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { eventService } from '../../src/modules/event/event.service.js';
import { runAsRequestViewer } from '../../src/shared/context/request-viewer.context.js';
import {
  createTenant,
  createActor,
  installFirebaseMock,
  headersFor,
  createEventWithDay,
  assign,
  deleteTenantsDeep,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  THE ASSIGNMENT LOCK (Team Members batch), over HTTP.
//
//  An EVENT_ADMIN with no assignments sees every event in the tenant; one
//  with any sees only those, and an unassigned event is the same 404 as
//  another tenant's, on the event AND its sub-resources. Creating an event
//  while locked assigns it. Removing the last assignment is 409
//  ASSIGNMENT_LOCK_RELEASE unless confirmWidening is true.
// ─────────────────────────────────────────

let tenantId: string;
let otherTenantId: string;
let admin: Actor;
let member: Actor;
let e1: { id: string; dayId: string };
let e2: { id: string; dayId: string; guestId: string; inviteId: string };
let foreignEventId: string;

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  otherTenantId = (await createTenant()).id;
  admin = await createActor('TENANT_ADMIN', tenantId);
  member = await createActor('EVENT_ADMIN', tenantId);
  const otherAdmin = await createActor('TENANT_ADMIN', otherTenantId);

  const one = await createEventWithDay(tenantId, admin.id, 'Assigned event');
  const two = await createEventWithDay(tenantId, admin.id, 'Unassigned event');
  e1 = { id: one.event.id, dayId: one.day.id };
  const { guest, invite } = await guestRepository.createWithInvite(two.event.id, admin.id, {
    firstName: 'Unassigned',
    surname: 'Guest',
    email: `lock-guest-${Date.now()}@test.invalid`,
    phoneNumber: null,
    eventDayIds: [two.day.id],
    plusOnesAllowed: 0,
  });
  e2 = { id: two.event.id, dayId: two.day.id, guestId: guest.id, inviteId: invite.id };
  foreignEventId = (await createEventWithDay(otherTenantId, otherAdmin.id, 'Other tenant event')).event.id;
}, 120000);

afterAll(async () => {
  await deleteTenantsDeep([tenantId, otherTenantId]);
}, 120000);

beforeEach(async () => {
  installFirebaseMock();
  await prisma.eventAssignment.deleteMany({ where: { userId: member.id } });
});

const get = (path: string, actor: Actor = member) => request(app).get(path).set(headersFor(actor));
const setAssignments = (body: unknown) =>
  request(app).put(`/api/users/${member.id}/assignments`).set(headersFor(admin)).send(body as object);

describe('an unlocked member (no assignments)', () => {
  it('sees every event in the tenant, and nothing outside it', async () => {
    const list = await get('/api/events');
    expect(list.status).toBe(200);
    const ids = list.body.data.map((e: { id: string }) => e.id);
    expect(ids).toEqual(expect.arrayContaining([e1.id, e2.id]));
    expect(ids).not.toContain(foreignEventId);

    expect((await get(`/api/events/${e2.id}`)).status).toBe(200);
    expect((await get(`/api/events/${e2.id}/guests`)).status).toBe(200);
    expect((await get(`/api/guests/${e2.guestId}`)).status).toBe(200);
  }, 60000);
});

describe('a locked member (assigned to one event)', () => {
  beforeEach(async () => {
    await assign(tenantId, member.id, e1.id, admin.id);
  });

  it('lists only the assigned event', async () => {
    const list = await get('/api/events');
    expect(list.status).toBe(200);
    expect(list.body.data.map((e: { id: string }) => e.id)).toEqual([e1.id]);
  }, 60000);

  it('gets 404 on the unassigned event, its guests, invites and check-in — and 200 on the assigned one', async () => {
    expect((await get(`/api/events/${e2.id}`)).status).toBe(404);
    expect((await get(`/api/events/${e2.id}/guests`)).status).toBe(404);
    expect((await get(`/api/events/${e2.id}/invites`)).status).toBe(404);
    expect((await get(`/api/events/${e2.id}/check-in/days/${e2.dayId}`)).status).toBe(404);
    expect((await request(app).put(`/api/events/${e2.id}`).set(headersFor(member)).send({ name: 'Hijacked' })).status).toBe(404);

    // The same as another tenant's event: identical status and body.
    const foreign = await get(`/api/events/${foreignEventId}`);
    const unassigned = await get(`/api/events/${e2.id}`);
    expect(unassigned.body).toEqual(foreign.body);

    // Control: the assigned event and its sub-resources work.
    expect((await get(`/api/events/${e1.id}`)).status).toBe(200);
    expect((await get(`/api/events/${e1.id}/guests`)).status).toBe(200);
    expect((await get(`/api/events/${e1.id}/invites`)).status).toBe(200);
    expect((await get(`/api/events/${e1.id}/check-in/days/${e1.dayId}`)).status).toBe(200);
    expect((await prisma.event.findUnique({ where: { id: e2.id } }))?.name).toBe('Unassigned event');
  }, 90000);

  it("reaches no guest of the unassigned event through /api/guests, nor its RSVP responses", async () => {
    expect((await get(`/api/guests/${e2.guestId}`)).status).toBe(404);
    const list = await get('/api/guests');
    expect(list.status).toBe(200);
    expect(list.body.data.map((g: { id: string }) => g.id)).not.toContain(e2.guestId);
    expect((await get(`/api/invites/${e2.inviteId}/rsvp-responses`)).status).toBe(404);
    // Control: a tenant admin is never locked.
    expect((await get(`/api/guests/${e2.guestId}`, admin)).status).toBe(200);
    expect((await get(`/api/invites/${e2.inviteId}/rsvp-responses`, admin)).status).toBe(200);
  }, 60000);

  it('can still import guests into the assigned event (the upload callback keeps the viewer)', async () => {
    const csv = Buffer.from('First Name,Surname,Contact\nImported,Guest,lock-import@test.invalid\n');
    const ok = await request(app)
      .post(`/api/events/${e1.id}/guests/import`)
      .set(headersFor(member))
      .attach('file', csv, { filename: 'guests.csv', contentType: 'text/csv' });
    expect(ok.status).toBe(200);
    const denied = await request(app)
      .post(`/api/events/${e2.id}/guests/import`)
      .set(headersFor(member))
      .attach('file', csv, { filename: 'guests.csv', contentType: 'text/csv' });
    expect(denied.status).toBe(404);
  }, 60000);

  it('is assigned automatically to an event they create', async () => {
    const created = await request(app).post('/api/events').set(headersFor(member)).send({ name: 'Made while locked' });
    expect(created.status).toBe(201);
    const assignment = await prisma.eventAssignment.findUnique({
      where: { userId_eventId: { userId: member.id, eventId: created.body.data.id } },
    });
    expect(assignment).not.toBeNull();
    expect((await get(`/api/events/${created.body.data.id}`)).status).toBe(200);
  }, 60000);
});

describe('creating an event while unlocked', () => {
  it('assigns nothing (that would lock the member to one event)', async () => {
    const created = await request(app).post('/api/events').set(headersFor(member)).send({ name: 'Made while unlocked' });
    expect(created.status).toBe(201);
    expect(await prisma.eventAssignment.count({ where: { userId: member.id } })).toBe(0);
  }, 60000);
});

describe('PUT /api/users/:id/assignments', () => {
  it('sets the list; removing the LAST one is 409 ASSIGNMENT_LOCK_RELEASE without confirmWidening', async () => {
    const set = await setAssignments({ eventIds: [e1.id] });
    expect(set.status).toBe(200);
    expect(set.body.data.assignments.map((a: { eventId: string }) => a.eventId)).toEqual([e1.id]);

    const refused = await setAssignments({ eventIds: [] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ASSIGNMENT_LOCK_RELEASE');
    // Still locked.
    expect((await get(`/api/events/${e2.id}`)).status).toBe(404);

    const confirmed = await setAssignments({ eventIds: [], confirmWidening: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.assignments).toEqual([]);
    expect((await get(`/api/events/${e2.id}`)).status).toBe(200);
  }, 60000);

  it("refuses another tenant's event (404) and a tenant admin (422)", async () => {
    expect((await setAssignments({ eventIds: [foreignEventId] })).status).toBe(404);
    const toAdmin = await request(app)
      .put(`/api/users/${admin.id}/assignments`)
      .set(headersFor(admin))
      .send({ eventIds: [e1.id] });
    expect(toAdmin.status).toBe(422);
  }, 60000);

  it('is TENANT_ADMIN only', async () => {
    const byMember = await request(app).put(`/api/users/${member.id}/assignments`).set(headersFor(member)).send({ eventIds: [] });
    expect(byMember.status).toBe(403);
  }, 60000);
});

describe('outside a request', () => {
  it('a locked role with no request viewer fails closed; with one it sees its events', async () => {
    await expect(eventService.getById(e1.id, 'EVENT_ADMIN', tenantId)).rejects.toMatchObject({ statusCode: 404 });
    const viewer = { userId: member.id, role: 'EVENT_ADMIN' as const, tenantId };
    const found = await runAsRequestViewer(viewer, () => eventService.getById(e1.id, 'EVENT_ADMIN', tenantId));
    expect(found.id).toBe(e1.id);
  }, 60000);
});
