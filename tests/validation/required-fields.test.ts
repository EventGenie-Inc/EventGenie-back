import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
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
//  REQUIRED FIELDS ARE ENFORCED ON THE SERVER
//
//  Every field the organiser UI marks required (and the RSVP form's
//  required questions) is refused with 422 and a message naming what's
//  missing when it is absent or blank — on the direct endpoints AND the
//  wizard's materialize path, which share the same validators. Each case
//  here accepted the blank (or crashed with a generic 500) before.
//  Event name/days/venue are covered in tests/event-day/.
// ─────────────────────────────────────────

type Actor = { id: string; firebaseUid: string; email: string; role: 'TENANT_ADMIN'; tenantId: string };
let owner: Actor;
let eventId: string;
let dayId: string;
let programId: string;
let headers: Record<string, string>;
const guestIds: string[] = [];

const VALID_DAY = { label: 'Day 1', date: '2030-01-01T00:00:00', location: 'Somewhere', address: '1 Test Road' };

beforeAll(async () => {
  const tenant = await createTestTenant();
  const u = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  owner = { id: u.id, firebaseUid: u.firebaseUid, email: u.email, role: 'TENANT_ADMIN', tenantId: tenant.id };
  eventId = (await createTestEvent(tenant.id, u.id)).id;
  dayId = (await createTestEventDay(eventId, u.id)).id;
  programId = (await prisma.eventProgram.create({ data: { eventId, createdBy: u.id, updatedBy: u.id } })).id;
  const session = jwt.sign(
    { userId: u.id, firebaseUid: u.firebaseUid, email: u.email, role: 'TENANT_ADMIN', tenantId: tenant.id },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  headers = { Authorization: 'Bearer required-fields', 'X-Session-Token': session };
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async () => ({ uid: owner.firebaseUid }));
});

afterAll(async () => {
  for (const id of guestIds) await deleteTestGuest(id);
  await prisma.rsvpField.deleteMany({ where: { eventId } });
  await prisma.ticket.deleteMany({ where: { eventId } });
  await prisma.programItem.deleteMany({ where: { programId } });
  await prisma.eventProgram.delete({ where: { id: programId } });
  await prisma.eventDay.deleteMany({ where: { eventId } });
  await deleteTestEvent(eventId);
  await prisma.eventDraft.deleteMany({ where: { createdByUserId: owner.id } });
  await deleteTestUserRow(owner.id);
  await deleteTestTenant(owner.tenantId);
  await prisma.$disconnect();
}, 60000);

const post = (path: string, body: Record<string, unknown>) => request(app).post(`/api/events/${eventId}${path}`).set(headers).send(body);

describe('organiser endpoints refuse blanks with 422', () => {
  it('program item: title and start time', async () => {
    const path = `/program/${programId}/items`;
    const blankTitle = await post(path, { title: '  ', startTime: '2030-01-01T10:00', order: 0 });
    expect(blankTitle.status).toBe(422);
    expect(blankTitle.body.message).toMatch(/needs a title/);
    const noStart = await post(path, { title: 'Vows', order: 0 });
    expect(noStart.status).toBe(422);
    expect(noStart.body.message).toMatch(/'Vows' needs a start date and time/);
    expect(await prisma.programItem.count({ where: { programId } })).toBe(0);

    const ok = await post(path, { title: 'Vows', startTime: '2030-01-01T10:00', order: 0 });
    expect(ok.status).toBe(201);
    const blankOnEdit = await request(app).put(`/api/events/${eventId}${path}/${ok.body.data.id}`).set(headers).send({ title: '' });
    expect(blankOnEdit.status).toBe(422);
  }, 60000);

  it('ticket: name and price', async () => {
    expect((await post('/tickets', { name: '', price: 100 })).status).toBe(422);
    const noPrice = await post('/tickets', { name: 'General' });
    expect(noPrice.status).toBe(422);
    expect(noPrice.body.message).toMatch(/'General' needs a price/);
    expect(await prisma.ticket.count({ where: { eventId } })).toBe(0);
  }, 60000);

  it('custom RSVP field: label and answer type', async () => {
    expect((await post('/rsvp-fields', { label: ' ', fieldType: 'TEXT', order: 0 })).status).toBe(422);
    expect((await post('/rsvp-fields', { label: 'Dietary needs', fieldType: 'ESSAY', order: 0 })).status).toBe(422);
    expect(await prisma.rsvpField.count({ where: { eventId } })).toBe(0);
  }, 60000);

  it('guest: a contact and (at least one) day; a blank contact on edit is not stored as ""', async () => {
    const noContact = await post('/guests', { firstName: 'A', eventDayIds: [dayId] });
    expect(noContact.status).toBe(422);
    const blankContact = await post('/guests', { email: '   ', eventDayIds: [dayId] });
    expect(blankContact.status).toBe(422);
    const noDays = await post('/guests', { email: `g-${randomUUID()}@test.invalid`, eventDayIds: [] });
    expect(noDays.status).toBe(422);
    expect(noDays.body.message).toMatch(/at least one day/);

    const created = await post('/guests', { email: `g-${randomUUID()}@test.invalid`, eventDayIds: [dayId] });
    expect(created.status).toBe(201);
    guestIds.push(created.body.data.id);
    const blanked = await request(app).put(`/api/guests/${created.body.data.id}`).set(headers).send({ email: '' });
    expect(blanked.status).toBe(422);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: created.body.data.id } })).email).toBe(created.body.data.email);
  }, 60000);
});

describe('wizard materialize refuses the same blanks', () => {
  const materialize = async (payload: Record<string, unknown>) => {
    await eventDraftRepository.upsert(owner.tenantId, owner.id, { currentStep: 4, payload });
    return eventDraftService.materialize(owner.tenantId, owner.id).catch((e) => e);
  };

  it('each required wizard field, and no event is created', async () => {
    const before = await prisma.event.count({ where: { tenantId: owner.tenantId } });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: ' ', days: [VALID_DAY] }, /needs a name/],
      [{ name: 'E', days: [{ ...VALID_DAY, location: '' }] }, /'Day 1' needs a venue name/],
      [{ name: 'E', days: [{ ...VALID_DAY, label: '' }] }, /needs a label/],
      [{ name: 'E', days: [VALID_DAY], program: { items: [{ title: '', startTime: '2030-01-01T10:00' }] } }, /needs a title/],
      [{ name: 'E', days: [VALID_DAY], program: { items: [{ title: 'Vows' }] } }, /'Vows' needs a start/],
      [{ name: 'E', days: [VALID_DAY], customFields: [{ label: '', fieldType: 'TEXT' }] }, /needs a label/],
      [{ name: 'E', days: [VALID_DAY], ticketing: 'PAID', tickets: [{ name: '', price: 10 }] }, /needs a name/],
    ];
    for (const [payload, message] of cases) {
      const err = await materialize(payload);
      expect(err, JSON.stringify(payload)).toMatchObject({ statusCode: 422 });
      expect(err.message).toMatch(message);
    }
    expect(await prisma.event.count({ where: { tenantId: owner.tenantId } })).toBe(before);
  }, 90000);
});

describe('RSVP submit refuses missing required answers', () => {
  it('attending must be given; required questions and a name are needed when attending', async () => {
    const field = await prisma.rsvpField.create({
      data: { eventId, label: 'Dietary needs', fieldType: 'TEXT', isRequired: true, order: 0, createdBy: owner.id, updatedBy: owner.id },
    });
    const { guest, invite } = await createTestGuestWithInvite(eventId, owner.id, [dayId]);
    guestIds.push(guest.id);
    await prisma.guest.update({ where: { id: guest.id }, data: { firstName: null } });
    const submit = (body: Record<string, unknown>) => request(app).post('/api/rsvp/submit').send({ token: invite.token, ...body });

    const noAnswer = await submit({});
    expect(noAnswer.status).toBe(422);
    expect(noAnswer.body.message).toMatch(/whether you'll be attending/);

    const noName = await submit({ attending: true, attendingDayIds: [dayId], rsvpResponses: [{ rsvpFieldId: field.id, value: 'None' }] });
    expect(noName.status).toBe(422);
    expect(noName.body.message).toMatch(/tell us your name/);

    const unanswered = await submit({ attending: true, firstName: 'Lebo', attendingDayIds: [dayId], rsvpResponses: [{ rsvpFieldId: field.id, value: '  ' }] });
    expect(unanswered.status).toBe(422);
    expect(unanswered.body.message).toMatch(/Please answer 'Dietary needs'/);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe('PENDING');

    const answered = await submit({ attending: true, firstName: 'Lebo', attendingDayIds: [dayId], rsvpResponses: [{ rsvpFieldId: field.id, value: 'Vegetarian' }] });
    expect(answered.status).toBe(200);
    // A decline needs no answers.
    const decline = await submit({ attending: false });
    expect(decline.status).toBe(200);
  }, 60000);
});
