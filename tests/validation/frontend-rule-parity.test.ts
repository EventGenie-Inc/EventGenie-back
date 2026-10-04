import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
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
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  THE SERVER REFUSES WHAT THE FRONTEND'S FORMS REFUSE
//
//  STEERING "Form validation": the UI never accepts what the server
//  refuses, nor refuses what it accepts. Each rule below existed only in
//  the frontend's shared form layer; a direct call could save the value,
//  and a decimal in an Int column came back as a generic 500. Every case
//  is a 422 with a plain message, and nothing is written.
// ─────────────────────────────────────────

type Actor = { id: string; firebaseUid: string };
let owner: Actor;
let superAdmin: Actor;
let tenantId: string;
let eventId: string;
let dayId: string;
let programId: string;
let ownerHeaders: Record<string, string>;
let superHeaders: Record<string, string>;
const guestIds: string[] = [];
let actingAs: Actor;

const sessionHeaders = (u: { id: string; firebaseUid: string; email: string }, role: string, tenant: string | null) => ({
  Authorization: 'Bearer rule-parity',
  'X-Session-Token': jwt.sign(
    { userId: u.id, firebaseUid: u.firebaseUid, email: u.email, role, tenantId: tenant },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  ),
});

beforeAll(async () => {
  const tenant = await createTestTenant();
  tenantId = tenant.id;
  const u = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
  const s = await createTestUserRow({ role: 'SUPER_ADMIN' });
  owner = { id: u.id, firebaseUid: u.firebaseUid };
  superAdmin = { id: s.id, firebaseUid: s.firebaseUid };
  ownerHeaders = sessionHeaders(u, 'TENANT_ADMIN', tenantId);
  superHeaders = sessionHeaders(s, 'SUPER_ADMIN', null);
  eventId = (await createTestEvent(tenantId, u.id)).id;
  dayId = (await createTestEventDay(eventId, u.id)).id;
  programId = (await prisma.eventProgram.create({ data: { eventId, createdBy: u.id, updatedBy: u.id } })).id;
}, 60000);

beforeEach(() => {
  actingAs = owner;
  mockVerifyIdToken.mockImplementation(async () => ({ uid: actingAs.firebaseUid }));
});

afterAll(async () => {
  for (const id of guestIds) await deleteTestGuest(id);
  await prisma.rsvpField.deleteMany({ where: { eventId } });
  await prisma.ticket.deleteMany({ where: { eventId } });
  await prisma.programItem.deleteMany({ where: { programId } });
  await prisma.eventProgram.delete({ where: { id: programId } });
  await prisma.eventDay.deleteMany({ where: { eventId } });
  await deleteTestEvent(eventId);
  await deleteTestUserRow(owner.id);
  await deleteTestUserRow(superAdmin.id);
  await deleteTestTenant(tenantId);
  await prisma.$disconnect();
}, 60000);

const post = (path: string, body: Record<string, unknown>) =>
  request(app).post(`/api/events/${eventId}${path}`).set(ownerHeaders).send(body);
const put = (path: string, body: Record<string, unknown>) =>
  request(app).put(`/api/events/${eventId}${path}`).set(ownerHeaders).send(body);

describe('whole numbers: program item duration, ticket quantity', () => {
  it('a decimal or negative duration is 422, not a 500; blank means no duration', async () => {
    const path = `/program/${programId}/items`;
    for (const durationMins of [12.5, -1, '30']) {
      const res = await post(path, { title: 'Vows', startTime: '2030-01-01T10:00', durationMins });
      expect(res.status, JSON.stringify(durationMins)).toBe(422);
      expect(res.body.message).toBe("Enter the duration of 'Vows' in whole minutes.");
    }
    expect(await prisma.programItem.count({ where: { programId } })).toBe(0);

    const ok = await post(path, { title: 'Vows', startTime: '2030-01-01T10:00', durationMins: 0 });
    expect(ok.status).toBe(201);
    const decimalEdit = await put(`${path}/${ok.body.data.id}`, { durationMins: 1.5 });
    expect(decimalEdit.status).toBe(422);
    const blankEdit = await put(`${path}/${ok.body.data.id}`, { durationMins: '' });
    expect(blankEdit.status).toBe(200);
    expect(blankEdit.body.data.durationMins).toBeNull();
  }, 60000);

  it('a decimal or negative ticket quantity is 422; blank means unlimited', async () => {
    for (const totalQuantity of [2.5, -3]) {
      const res = await post('/tickets', { name: 'General', price: 100, totalQuantity });
      expect(res.status).toBe(422);
      expect(res.body.message).toBe("Enter a whole number of tickets for 'General', or leave it blank for unlimited.");
    }
    expect(await prisma.ticket.count({ where: { eventId } })).toBe(0);

    const blank = await post('/tickets', { name: 'General', price: 100, totalQuantity: '' });
    expect(blank.status).toBe(201);
    expect(blank.body.data.totalQuantity).toBeNull();
    const edit = await put(`/tickets/${blank.body.data.id}`, { totalQuantity: 0.5 });
    expect(edit.status).toBe(422);
  }, 60000);
});

describe('tier limits', () => {
  it('all four refuse a decimal or negative with 422; blank sets unlimited', async () => {
    actingAs = superAdmin;
    // The test database may hold no tier configs (the seed never runs
    // there): make a SPARK row for this test if there isn't one, and put
    // back exactly what was there afterwards.
    const existing = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'SPARK' } });
    const before =
      existing ?? (await prisma.subscriptionTierConfig.create({ data: { tier: 'SPARK', maxEvents: 3, maxGuestsPerEvent: 100, maxSmsPerMonth: 0, maxVendorSpaces: 0 } }));
    const labels = {
      maxEvents: 'Max events',
      maxGuestsPerEvent: 'Max guests / event',
      maxSmsPerMonth: 'Max SMS / month',
      maxVendorSpaces: 'Max vendor spaces',
    } as const;
    try {
      for (const [field, label] of Object.entries(labels)) {
        for (const value of [1.5, -1]) {
          const res = await request(app).put('/api/subscription-tiers/SPARK').set(superHeaders).send({ [field]: value });
          expect(res.status, `${field}=${value}`).toBe(422);
          expect(res.body.message).toBe(`Enter a whole number of 0 or more for ${label}, or leave it blank for unlimited.`);
        }
      }
      expect(await prisma.subscriptionTierConfig.findUniqueOrThrow({ where: { tier: 'SPARK' } })).toEqual(before);

      const blank = await request(app).put('/api/subscription-tiers/SPARK').set(superHeaders).send({ maxEvents: '  ' });
      expect(blank.status).toBe(200);
      expect(blank.body.data.maxEvents).toBeNull();
    } finally {
      if (!existing) {
        await prisma.subscriptionTierConfig.delete({ where: { tier: 'SPARK' } });
      } else {
        await prisma.subscriptionTierConfig.update({
          where: { tier: 'SPARK' },
          data: {
            maxEvents: before.maxEvents,
            maxGuestsPerEvent: before.maxGuestsPerEvent,
            maxSmsPerMonth: before.maxSmsPerMonth,
            maxVendorSpaces: before.maxVendorSpaces,
          },
        });
      }
    }
  }, 90000);
});

describe('event day: end time after start time', () => {
  it('refused on create and on an update judged against the stored times', async () => {
    const day = { label: 'Evening', date: '2030-02-01', location: 'Hall', address: '1 Road' };
    const backwards = await post('/days', { ...day, startTime: '2030-02-01T18:00:00', endTime: '2030-02-01T17:00:00' });
    expect(backwards.status).toBe(422);
    expect(backwards.body.message).toBe("The end time of 'Evening' must be after its start time.");
    const same = await post('/days', { ...day, startTime: '2030-02-01T18:00:00', endTime: '2030-02-01T18:00:00' });
    expect(same.status).toBe(422);
    expect(await prisma.eventDay.count({ where: { eventId, label: 'Evening' } })).toBe(0);

    const ok = await post('/days', { ...day, startTime: '2030-02-01T18:00:00', endTime: '2030-02-01T22:00:00' });
    expect(ok.status).toBe(201);
    // Only the end time sent: judged against the stored start.
    const earlyEnd = await put(`/days/${ok.body.data.id}`, { endTime: '2030-02-01T12:00:00' });
    expect(earlyEnd.status).toBe(422);
    await prisma.eventDay.delete({ where: { id: ok.body.data.id } });
  }, 60000);
});

describe('program item: a day is required on a multi-day event', () => {
  it('refused without one (or cleared) once the event has two days; fine on a single-day event', async () => {
    const path = `/program/${programId}/items`;
    const single = await post(path, { title: 'Single-day item', startTime: '2030-01-01T09:00' });
    expect(single.status).toBe(201);

    const second = await createTestEventDay(eventId, owner.id, 'Day 2');
    try {
      const noDay = await post(path, { title: 'Speeches', startTime: '2030-01-01T12:00' });
      expect(noDay.status).toBe(422);
      expect(noDay.body.message).toBe("Choose the day 'Speeches' happens on — this event has more than one day.");

      const withDay = await post(path, { title: 'Speeches', startTime: '2030-01-01T12:00', eventDayId: second.id });
      expect(withDay.status).toBe(201);
      const cleared = await put(`${path}/${withDay.body.data.id}`, { eventDayId: null });
      expect(cleared.status).toBe(422);
      // An older item with no day can still be edited without picking one.
      const legacyEdit = await put(`${path}/${single.body.data.id}`, { title: 'Renamed' });
      expect(legacyEdit.status).toBe(200);
    } finally {
      await prisma.programItem.deleteMany({ where: { eventDayId: second.id } });
      await prisma.eventDay.delete({ where: { id: second.id } });
    }
  }, 120000);
});

describe('SMS credit purchase: 1 to 5000', () => {
  it('outside the range, or not whole, is 422 before anything else is looked at', async () => {
    for (const smsCount of [0, 5001, 10.5, '100']) {
      const res = await post('/pass/sms-bundle/purchase', { smsCount });
      expect(res.status, JSON.stringify(smsCount)).toBe(422);
      expect(res.body.message).toBe('Enter a whole number of SMS credits from 1 to 5000.');
    }
    // 5000 passes the count check and reaches the next rule (this event
    // has no active pass), which is a different refusal.
    const max = await post('/pass/sms-bundle/purchase', { smsCount: 5000 });
    expect(max.body.message).not.toBe('Enter a whole number of SMS credits from 1 to 5000.');
  }, 60000);
});

describe('host name: at most 200 characters', () => {
  it('refused on update over 200 (after trimming); 200 is fine', async () => {
    const long = await put('', { hostName: 'x'.repeat(201) });
    expect(long.status).toBe(422);
    expect(long.body.message).toBe('Keep the host name to 200 characters or fewer.');
    const exact = await put('', { hostName: `  ${'x'.repeat(200)}  ` });
    expect(exact.status).toBe(200);
    const created = await request(app).post('/api/events').set(ownerHeaders).send({ name: 'Long host', hostName: 'y'.repeat(201) });
    expect(created.status).toBe(422);
  }, 60000);
});

describe('custom question answers by type', () => {
  it('EMAIL, PHONE and NUMBER answers must be that type; blank and other types pass', async () => {
    const make = (label: string, fieldType: 'EMAIL' | 'PHONE' | 'NUMBER' | 'TEXT', order: number) =>
      prisma.rsvpField.create({ data: { eventId, label, fieldType, isRequired: false, order, createdBy: owner.id, updatedBy: owner.id } });
    const email = await make('Work email', 'EMAIL', 10);
    const phone = await make('Emergency contact', 'PHONE', 11);
    const number = await make('Shoe size', 'NUMBER', 12);
    const text = await make('Song request', 'TEXT', 13);
    const { guest, invite } = await createTestGuestWithInvite(eventId, owner.id, [dayId]);
    guestIds.push(guest.id);
    const submit = (rsvpFieldId: string, value: string) =>
      request(app).post('/api/rsvp/submit').send({
        token: invite.token,
        attending: true,
        attendingDayIds: [dayId],
        rsvpResponses: [{ rsvpFieldId, value }],
      });

    const cases: [string, string, string][] = [
      [email.id, 'not-an-email', "Enter an email address like name@example.com for 'Work email'."],
      [phone.id, '0821234567', "Use the format +27 82 123 4567 for 'Emergency contact'."],
      [phone.id, '+27 12', "Use the format +27 82 123 4567 for 'Emergency contact'."],
      [number.id, 'eight', "Enter a number for 'Shoe size'."],
      [number.id, '0x1f', "Enter a number for 'Shoe size'."],
    ];
    for (const [fieldId, value, message] of cases) {
      const res = await submit(fieldId, value);
      expect(res.status, value).toBe(422);
      expect(res.body.message).toBe(message);
    }
    expect(await prisma.rsvpResponse.count({ where: { inviteId: invite.id } })).toBe(0);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe('PENDING');

    for (const [fieldId, value] of [
      [email.id, 'thandi@example.com'],
      [phone.id, '+27 82 123 4567'],
      [number.id, '-7.5'],
      [number.id, '   '],
      [text.id, 'anything at all'],
    ] as const) {
      expect((await submit(fieldId, value)).status, value).toBe(200);
    }
  }, 90000);
});

describe('an invalid international phone number', () => {
  it('says "Use the format +27 82 123 4567" with CONTACT_PHONE_INVALID, on RSVP and on guest create', async () => {
    const { guest, invite } = await createTestGuestWithInvite(eventId, owner.id, [dayId]);
    guestIds.push(guest.id);
    const rsvp = await request(app).post('/api/rsvp/submit').send({ token: invite.token, attending: false, phoneNumber: '+27 12' });
    expect(rsvp.status).toBe(422);
    expect(rsvp.body).toMatchObject({ message: 'Use the format +27 82 123 4567', code: 'CONTACT_PHONE_INVALID' });

    // Guest create keeps its long-standing 400 (see the report); same words and code.
    const created = await post('/guests', { phoneNumber: '+27 12', eventDayIds: [dayId], firstName: `G ${randomUUID()}` });
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ message: 'Use the format +27 82 123 4567', code: 'CONTACT_PHONE_INVALID' });
  }, 60000);
});
