import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  PROGRAM DEFAULTS
//
//  1. A program is visible to guests by default — on both creation paths
//     (POST .../program and the wizard's materialize) — and an organiser
//     can still hide it. Organisers reported the Program tab never
//     appearing: every program was created hidden and nothing in the UI
//     could un-hide it.
//  2. 20261001100000_program_published_by_default makes every existing
//     non-archived program visible and leaves archived ones alone.
//  3. A program item created without `order` goes to the end of its
//     program's list (it was a Prisma 500); an invalid order is a 422.
// ─────────────────────────────────────────

let owner: { id: string; firebaseUid: string; email: string; tenantId: string };
let eventId: string;
let dayId: string;
let headers: Record<string, string>;
const extraEventIds: string[] = [];
let guestId: string | null = null;

beforeAll(async () => {
  const tenant = await createTestTenant();
  const u = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  owner = { id: u.id, firebaseUid: u.firebaseUid, email: u.email, tenantId: tenant.id };
  eventId = (await createTestEvent(tenant.id, u.id)).id;
  dayId = (await createTestEventDay(eventId, u.id)).id;
  const session = jwt.sign(
    { userId: u.id, firebaseUid: u.firebaseUid, email: u.email, role: 'TENANT_ADMIN', tenantId: tenant.id },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  headers = { Authorization: 'Bearer program-defaults', 'X-Session-Token': session };
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async () => ({ uid: owner.firebaseUid }));
});

const deleteEventWithProgram = async (id: string) => {
  const programs = await prisma.eventProgram.findMany({ where: { eventId: id } });
  for (const p of programs) {
    await prisma.programItem.deleteMany({ where: { programId: p.id } });
    await prisma.eventProgram.delete({ where: { id: p.id } });
  }
  await prisma.eventDay.deleteMany({ where: { eventId: id } });
  await deleteTestEvent(id);
};

afterAll(async () => {
  if (guestId) await deleteTestGuest(guestId);
  for (const id of [eventId, ...extraEventIds]) await deleteEventWithProgram(id);
  await prisma.eventDraft.deleteMany({ where: { createdByUserId: owner.id } });
  await deleteTestUserRow(owner.id);
  await deleteTestTenant(owner.tenantId);
  await prisma.$disconnect();
}, 60000);

describe('programs are visible to guests by default', () => {
  it('POST .../program creates it visible; a guest sees it; the organiser can still hide it', async () => {
    const created = await request(app).post(`/api/events/${eventId}/program`).set(headers).send({ title: 'Order of the day' });
    expect(created.status).toBe(201);
    expect(created.body.data.isPublished).toBe(true);
    const programId = created.body.data.id as string;

    const item = await request(app)
      .post(`/api/events/${eventId}/program/${programId}/items`)
      .set(headers)
      .send({ title: 'Vows', startTime: '2027-01-01T14:00' });
    expect(item.status).toBe(201);

    const { guest, invite } = await createTestGuestWithInvite(eventId, owner.id, [dayId]);
    guestId = guest.id;
    const shown = await request(app).post('/api/rsvp/program').send({ token: invite.token });
    expect(shown.body.data.available).toBe(true);

    const hidden = await request(app).put(`/api/events/${eventId}/program/${programId}`).set(headers).send({ isPublished: false });
    expect(hidden.body.data.isPublished).toBe(false);
    expect((await request(app).post('/api/rsvp/program').send({ token: invite.token })).body.data).toEqual({ available: false });
  }, 60000);

  it("the wizard's materialize creates it visible", async () => {
    await eventDraftRepository.upsert(owner.tenantId, owner.id, {
      currentStep: 4,
      payload: {
        name: 'Wizard program',
        days: [{ label: 'Day 1', date: '2030-01-01T00:00:00', location: 'Somewhere', address: '1 Test Road' }],
        program: { title: 'Programme', items: [{ title: 'Welcome', startTime: '2030-01-01T10:00' }] },
      },
    });
    const event = await eventDraftService.materialize(owner.tenantId, owner.id);
    extraEventIds.push(event!.id);
    expect(event!.program).toMatchObject({ isPublished: true });
  }, 60000);
});

describe('migration 20261001100000_program_published_by_default', () => {
  it('makes non-archived programs visible and leaves archived ones alone', async () => {
    const make = async (isArchived: boolean) => {
      const e = await createTestEvent(owner.tenantId, owner.id);
      extraEventIds.push(e.id);
      return prisma.eventProgram.create({
        data: { eventId: e.id, isPublished: false, isArchived, createdBy: owner.id, updatedBy: owner.id },
      });
    };
    const live = await make(false);
    const archived = await make(true);

    const sql = readFileSync('prisma/migrations/20261001100000_program_published_by_default/migration.sql', 'utf8');
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('DO $$')));

    expect((await prisma.eventProgram.findUniqueOrThrow({ where: { id: live.id } })).isPublished).toBe(true);
    expect((await prisma.eventProgram.findUniqueOrThrow({ where: { id: archived.id } })).isPublished).toBe(false);
  }, 60000);
});

describe('program item order', () => {
  it('omitted → the end of the program\'s list; invalid → 422', async () => {
    const program = await prisma.eventProgram.findFirstOrThrow({ where: { eventId, isArchived: false } });
    const url = `/api/events/${eventId}/program/${program.id}/items`;

    const explicit = await request(app).post(url).set(headers).send({ title: 'Speeches', startTime: '2027-01-01T18:00', order: 7 });
    expect(explicit.status).toBe(201);
    const appended = await request(app).post(url).set(headers).send({ title: 'First dance', startTime: '2027-01-01T19:00' });
    expect(appended.status).toBe(201);
    expect(appended.body.data.order).toBe(8);

    const bad = await request(app).post(url).set(headers).send({ title: 'Cake', startTime: '2027-01-01T20:00', order: 'last' });
    expect(bad.status).toBe(422);
  }, 60000);

  it('the first item in an empty program gets order 0', async () => {
    const e = await createTestEvent(owner.tenantId, owner.id);
    extraEventIds.push(e.id);
    const program = await request(app).post(`/api/events/${e.id}/program`).set(headers).send({});
    const first = await request(app)
      .post(`/api/events/${e.id}/program/${program.body.data.id}/items`)
      .set(headers)
      .send({ title: 'Doors open', startTime: '2027-01-01T17:00' });
    expect(first.status).toBe(201);
    expect(first.body.data.order).toBe(0);
  }, 60000);
});
