import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
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
//  PROGRAMS AND INVITES BELONG TO THE EVENT IN THEIR URL
//
//  GET/PUT/DELETE /api/events/:eventId/program/:id and the invite routes
//  (/invites/:id, /:id/reactivate, /:id/resend) used to gate only on the
//  record's own event, so a tenant's program or invite could be read,
//  edited, archived, restored or resent under any of that tenant's event
//  URLs. Now the URL's event is gated first (tenant scoping and the
//  assignment lock) and the record must be that event's: anything else is
//  a 404, never a 403, and nothing is written.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let outsider: Actor;
let lockedMember: Actor; // assigned to event A only
let eventA: string;
let eventB: string;
let programA: string;
let programB: string;
let inviteB: string;
let inviteA: string;

beforeAll(async () => {
  const tenant = await createTenant();
  const other = await createTenant();
  tenantIds.push(tenant.id, other.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  outsider = await createActor('TENANT_ADMIN', other.id);
  lockedMember = await createActor('EVENT_ADMIN', tenant.id);
  const a = await createEventWithDay(tenant.id, organiser.id);
  const b = await createEventWithDay(tenant.id, organiser.id);
  eventA = a.event.id;
  eventB = b.event.id;
  await assign(tenant.id, lockedMember.id, eventA, organiser.id);
  const program = (eventId: string) =>
    prisma.eventProgram.create({ data: { eventId, title: 'Program', createdBy: organiser.id, updatedBy: organiser.id } });
  programA = (await program(eventA)).id;
  programB = (await program(eventB)).id;
  const invite = async (eventId: string, dayId: string, name: string) =>
    (
      await guestRepository.createWithInvite(eventId, organiser.id, {
        firstName: name,
        surname: 'Guest',
        email: `${name.toLowerCase()}-${eventId}@test.invalid`,
        phoneNumber: null,
        eventDayIds: [dayId],
        plusOnesAllowed: 0,
      })
    ).invite.id;
  inviteA = await invite(eventA, a.day.id, 'Ayanda');
  inviteB = await invite(eventB, b.day.id, 'Bongani');
}, 60000);

beforeEach(() => installFirebaseMock());

afterAll(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
  await prisma.$disconnect();
}, 60000);

// Event B's program and invite as stored: equal before and after means
// nothing was written.
const storedB = async () =>
  JSON.stringify({
    program: await prisma.eventProgram.findUnique({ where: { id: programB } }),
    invite: await prisma.invite.findUnique({ where: { id: inviteB } }),
    sent: await prisma.eventEmailClaim.count({ where: { eventId: eventB } }),
  });

type Call = [method: 'get' | 'put' | 'delete' | 'post', path: string, body?: object];

const PROGRAM_ROUTES: Record<string, (eventId: string, programId: string) => Call> = {
  'GET /program/:id': (e, p) => ['get', `/api/events/${e}/program/${p}`],
  'PUT /program/:id': (e, p) => ['put', `/api/events/${e}/program/${p}`, { title: 'Hijacked', isPublished: false }],
  'DELETE /program/:id': (e, p) => ['delete', `/api/events/${e}/program/${p}`],
};

const INVITE_ROUTES: Record<string, (eventId: string, inviteId: string) => Call> = {
  'GET /invites/:id': (e, i) => ['get', `/api/events/${e}/invites/${i}`],
  'PUT /invites/:id': (e, i) => ['put', `/api/events/${e}/invites/${i}`, { status: 'DECLINED' }],
  'DELETE /invites/:id': (e, i) => ['delete', `/api/events/${e}/invites/${i}`],
  'POST /invites/:id/reactivate': (e, i) => ['post', `/api/events/${e}/invites/${i}/reactivate`],
  'POST /invites/:id/resend': (e, i) => ['post', `/api/events/${e}/invites/${i}/resend`],
};

const send = (actor: Actor, [method, path, body]: Call) => {
  const req = request(app)[method](path).set(headersFor(actor));
  return body ? req.send(body) : req;
};

describe("another event's program or invite under this event's URL is a 404, and nothing is written", () => {
  for (const [name, route] of Object.entries(PROGRAM_ROUTES)) {
    it(name, async () => {
      const before = await storedB();
      const res = await send(organiser, route(eventA, programB));
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.message).toBe('Program not found');
      expect(await storedB()).toBe(before);
    }, 60000);
  }
  for (const [name, route] of Object.entries(INVITE_ROUTES)) {
    it(name, async () => {
      const before = await storedB();
      const res = await send(organiser, route(eventA, inviteB));
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.message).toBe('Invite not found');
      expect(await storedB()).toBe(before);
    }, 60000);
  }
});

describe('under their own URL', () => {
  const everyRoute = (eventId: string, programId: string, inviteId: string) => [
    ...Object.entries(PROGRAM_ROUTES).map(([name, route]) => [name, route(eventId, programId)] as const),
    ...Object.entries(INVITE_ROUTES).map(([name, route]) => [name, route(eventId, inviteId)] as const),
  ];

  it("another tenant's organiser gets a 404 on every route, and nothing is written", async () => {
    const before = await storedB();
    for (const [name, call] of everyRoute(eventB, programB, inviteB)) {
      expect((await send(outsider, call)).status, name).toBe(404);
    }
    expect(await storedB()).toBe(before);
  }, 120000);

  it('a locked member gets a 404 on every route of an event they are not assigned to', async () => {
    const before = await storedB();
    for (const [name, call] of everyRoute(eventB, programB, inviteB)) {
      expect((await send(lockedMember, call)).status, name).toBe(404);
    }
    expect(await storedB()).toBe(before);
  }, 120000);

  it('the organiser, and the member on their assigned event, still reach them', async () => {
    for (const actor of [organiser, lockedMember]) {
      const program = await send(actor, ['get', `/api/events/${eventA}/program/${programA}`]);
      expect(program.status).toBe(200);
      expect(program.body.data.id).toBe(programA);
      const invite = await send(actor, ['get', `/api/events/${eventA}/invites/${inviteA}`]);
      expect(invite.status).toBe(200);
      expect(invite.body.data.id).toBe(inviteA);
    }
    const put = await send(organiser, ['put', `/api/events/${eventA}/program/${programA}`, { title: 'Order of the day' }]);
    expect(put.status).toBe(200);
    expect(put.body.data.title).toBe('Order of the day');
  }, 60000);
});
