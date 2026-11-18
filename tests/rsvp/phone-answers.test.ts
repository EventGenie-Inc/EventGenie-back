import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
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
import { createPublicEvent, cleanupPublicEventFixtures, register, freshEmail } from '../public-events/helpers.js';

// ─────────────────────────────────────────
//  PHONE QUESTIONS FOLLOW THE CONTACT NUMBER'S RULE
//
//  An answer to a PHONE question (RSVP submit and self-registration) is
//  read like a contact number: with a country code, that country; without
//  one, the answer's own phoneCountry, South Africa when none is sent. It
//  is stored, and answered back, in international form (E.164). An
//  unknown phoneCountry or a number that isn't one is 422
//  RSVP_ANSWER_INVALID, and nothing is stored.
// ─────────────────────────────────────────

let tenantId: string;
let ownerId: string;
let eventId: string;
let dayId: string;
let phoneFieldId: string;
const guestIds: string[] = [];

beforeAll(async () => {
  tenantId = (await createTestTenant()).id;
  ownerId = (await createTestUserRow({ role: 'TENANT_ADMIN', tenantId })).id;
  eventId = (await createTestEvent(tenantId, ownerId)).id;
  dayId = (await createTestEventDay(eventId, ownerId)).id;
  phoneFieldId = (
    await prisma.rsvpField.create({
      data: { eventId, label: 'Emergency contact', fieldType: 'PHONE', isRequired: false, order: 1, createdBy: ownerId, updatedBy: ownerId },
    })
  ).id;
});

afterAll(async () => {
  for (const id of guestIds) await deleteTestGuest(id);
  await prisma.rsvpField.deleteMany({ where: { eventId } });
  await prisma.eventDay.deleteMany({ where: { eventId } });
  await deleteTestEvent(eventId);
  await deleteTestUserRow(ownerId);
  await deleteTestTenant(tenantId);
  await cleanupPublicEventFixtures();
});

const rsvpWith = async (answer: Record<string, unknown>) => {
  const { guest, invite } = await createTestGuestWithInvite(eventId, ownerId, [dayId]);
  guestIds.push(guest.id);
  const res = await request(app)
    .post('/api/rsvp/submit')
    .send({ token: invite.token, attending: true, attendingDayIds: [dayId], rsvpResponses: [{ rsvpFieldId: phoneFieldId, ...answer }] });
  const stored = await prisma.rsvpResponse.findMany({ where: { inviteId: invite.id } });
  return { res, stored: stored.map((r) => r.value) };
};

describe('RSVP: a PHONE answer', () => {
  it('without a country code is read in South Africa by default and stored in international form', async () => {
    for (const value of ['082 123 4567', '0821234567', '27821234567', '+27 (0)82 123 4567']) {
      const { res, stored } = await rsvpWith({ value });
      expect(res.status, value).toBe(200);
      expect(stored, value).toEqual(['+27821234567']);
      expect(res.body.data.rsvpResponses, value).toEqual([expect.objectContaining({ rsvpFieldId: phoneFieldId, value: '+27821234567' })]);
    }
  }, 120000);

  it('without a country code is read in the answer’s phoneCountry', async () => {
    const { res, stored } = await rsvpWith({ value: '07911 123456', phoneCountry: 'gb' });
    expect(res.status).toBe(200);
    expect(stored).toEqual(['+447911123456']);
  }, 60000);

  it('with a country code is that country, whatever phoneCountry says', async () => {
    const { res, stored } = await rsvpWith({ value: '+44 7911 123456', phoneCountry: 'ZA' });
    expect(res.status).toBe(200);
    expect(stored).toEqual(['+447911123456']);
  }, 60000);

  it('refuses an unknown phoneCountry and a number that isn’t one, storing nothing', async () => {
    const badCountry = await rsvpWith({ value: '07911 123456', phoneCountry: 'XX' });
    expect(badCountry.res.status).toBe(422);
    expect(badCountry.res.body).toMatchObject({
      code: 'RSVP_ANSWER_INVALID',
      message: "Choose a country for the phone number in 'Emergency contact' from the list.",
    });
    expect(badCountry.stored).toEqual([]);

    // A GB number read in South Africa isn't a number.
    for (const value of ['07911 123456', '+27 12', '082 12']) {
      const bad = await rsvpWith({ value });
      expect(bad.res.status, value).toBe(422);
      expect(bad.res.body, value).toMatchObject({ code: 'RSVP_ANSWER_INVALID', message: "Enter a valid phone number for 'Emergency contact'." });
      expect(bad.stored, value).toEqual([]);
    }
  }, 120000);

  it('refuses a phoneCountry that isn’t text as a malformed answer (400)', async () => {
    const { res, stored } = await rsvpWith({ value: '0821234567', phoneCountry: 27 });
    expect(res.status).toBe(400);
    expect(stored).toEqual([]);
  }, 60000);
});

describe('self-registration: a PHONE answer', () => {
  it('is read like a contact number and stored in international form', async () => {
    const ev = await createPublicEvent();
    const field = await prisma.rsvpField.create({
      data: { eventId: ev.eventId, label: 'Emergency contact', fieldType: 'PHONE', isRequired: true, order: 1, createdBy: ev.organiser.id, updatedBy: ev.organiser.id },
    });
    const storedFor = async (email: string) => {
      const invite = await prisma.invite.findFirstOrThrow({ where: { eventId: ev.eventId, guest: { email } }, include: { rsvpResponses: true } });
      return invite.rsvpResponses.map((r) => r.value);
    };

    const local = freshEmail();
    expect((await register(ev.shareToken, { email: local, rsvpResponses: [{ rsvpFieldId: field.id, value: '082 123 4567' }] })).status).toBe(201);
    expect(await storedFor(local)).toEqual(['+27821234567']);

    const abroad = freshEmail();
    const gb = await register(ev.shareToken, { email: abroad, rsvpResponses: [{ rsvpFieldId: field.id, value: '07911 123456', phoneCountry: 'GB' }] });
    expect(gb.status).toBe(201);
    expect(await storedFor(abroad)).toEqual(['+447911123456']);

    const refused = await register(ev.shareToken, { rsvpResponses: [{ rsvpFieldId: field.id, value: '07911 123456' }] });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'RSVP_ANSWER_INVALID', message: "Enter a valid phone number for 'Emergency contact'." });
    expect(await prisma.guest.count({ where: { eventId: ev.eventId } })).toBe(2);
  }, 120000);
});
