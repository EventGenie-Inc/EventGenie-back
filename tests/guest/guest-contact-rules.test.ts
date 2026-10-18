import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import {
  createTenant,
  createActor,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  type Actor,
} from '../helpers/team.js';
import { prisma } from '../helpers/team.js';

// ─────────────────────────────────────────
//  GUEST CONTACT RULES
//
//  A phone is never anyone's identity: two guests on one event may share
//  one, on organiser create, import and RSVP, and nothing refuses or
//  mentions another guest's phone. An email still is: changing to one
//  another guest has is refused at RSVP with one neutral message and code.
//  "Exactly one contact" is a creation rule: an update checks only what
//  it changes. The plus-ones allowance is a whole number from 0 to 20.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  if (tenantIds.length) await deleteTenantsDeep(tenantIds.splice(0));
});

const phone = () => `+2782${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const email = () => `guest-${randomUUID()}@test.invalid`;

const setup = async () => {
  installFirebaseMock();
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event, day } = await createEventWithDay(tenant.id, organiser.id);
  return { organiser, event, day };
};

const createGuest = (ctx: { organiser: Actor; event: { id: string }; day: { id: string } }, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/events/${ctx.event.id}/guests`)
    .set(headersFor(ctx.organiser))
    .send({ firstName: 'Guest', eventDayIds: [ctx.day.id], ...body });

const updateGuest = (organiser: Actor, id: string, body: Record<string, unknown>) =>
  request(app).put(`/api/guests/${id}`).set(headersFor(organiser)).send(body);

const tokenOf = async (guestId: string) => (await prisma.invite.findFirstOrThrow({ where: { guestId } })).token;
const submit = (body: Record<string, unknown>) => request(app).post('/api/rsvp/submit').send({ attending: false, ...body });

const NEVER_SAID = /another guest|already (exists|using|in use)|duplicate/i;

describe('phones are not unique', () => {
  it('organiser create: a second guest with the same phone is created', async () => {
    const ctx = await setup();
    const shared = phone();
    const first = await createGuest(ctx, { phoneNumber: shared });
    const second = await createGuest(ctx, { firstName: 'Partner', phoneNumber: shared });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.text).not.toMatch(NEVER_SAID);
    expect(await prisma.guest.count({ where: { eventId: ctx.event.id, phoneNumber: shared } })).toBe(2);
  }, 60000);

  it('import: a row with a phone an existing guest has imports; the same phone twice in one file flags the repeat', async () => {
    const ctx = await setup();
    const shared = phone();
    const other = phone();
    expect((await createGuest(ctx, { phoneNumber: shared })).status).toBe(201);
    const csv = Buffer.from(
      `First Name,Surname,Contact\nAyanda,Dube,${shared}\nLungi,Dube,${other}\nPasted,Twice,${other.replace('+27', '+27 ')}\n`
    );
    const res = await request(app)
      .post(`/api/events/${ctx.event.id}/guests/import`)
      .set(headersFor(ctx.organiser))
      .attach('file', csv, { filename: 'guests.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    // Against existing guests a phone is never a duplicate; within the
    // file a repeated one is a duplicated row, flagged like a repeated email.
    expect(res.body.data).toMatchObject({ totalRows: 3, created: 2, failed: 1 });
    expect(res.body.data.failures).toEqual([
      {
        row: 4,
        contact: other.replace('+27', '+27 '),
        reason: `Duplicate contact '${other.replace('+27', '+27 ')}' — appears more than once in this file (first seen on row 3)`,
      },
    ]);
    expect(res.text).not.toMatch(/another guest|already exists/i);
    expect(await prisma.guest.count({ where: { eventId: ctx.event.id, phoneNumber: shared } })).toBe(2);
    expect(await prisma.guest.count({ where: { eventId: ctx.event.id, phoneNumber: other } })).toBe(1);
  }, 60000);

  it('RSVP: a guest can change their number to one another guest has; nothing mentions the other guest', async () => {
    const ctx = await setup();
    const shared = phone();
    const a = await createGuest(ctx, { phoneNumber: shared });
    const b = await createGuest(ctx, { firstName: 'Bongani', email: email() });
    const aBefore = await prisma.guest.findUniqueOrThrow({ where: { id: a.body.data.id } });

    const res = await submit({ token: await tokenOf(b.body.data.id), phoneNumber: shared });
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(NEVER_SAID);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: b.body.data.id } })).phoneNumber).toBe(shared);
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: a.body.data.id } })).toEqual(aBefore);
  }, 60000);
});

describe('changing to an email another guest has, at RSVP', () => {
  it('is refused with the one neutral message and code, in any casing, and nothing changes', async () => {
    const ctx = await setup();
    const taken = email();
    const a = await createGuest(ctx, { email: taken });
    const ownEmail = email();
    const b = await createGuest(ctx, { firstName: 'Bongani', email: ownEmail });
    const token = await tokenOf(b.body.data.id);

    for (const tried of [taken, `  ${taken.toUpperCase()} `]) {
      const res = await submit({ token, email: tried });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        status: 'error',
        message: "That email address can't be used for this invitation. Please use another one.",
        code: 'CONTACT_EMAIL_UNAVAILABLE',
      });
    }
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: b.body.data.id } })).email).toBe(ownEmail);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: a.body.data.id } })).email).toBe(taken);

    // An address nobody on the event has is accepted.
    const free = email();
    expect((await submit({ token, email: free })).status).toBe(200);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: b.body.data.id } })).email).toBe(free);
  }, 60000);
});

describe('an organiser changing a guest’s email to another guest’s', () => {
  it('is refused with 409 GUEST_EMAIL_TAKEN in any casing, and nothing changes; their own or a free address is fine', async () => {
    const ctx = await setup();
    const taken = email();
    await createGuest(ctx, { email: taken });
    const own = email();
    const b = await createGuest(ctx, { firstName: 'Bongani', email: own });
    const id = b.body.data.id as string;

    for (const tried of [taken, `  ${taken.toUpperCase()} `]) {
      const res = await updateGuest(ctx.organiser, id, { email: tried });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        status: 'error',
        message: 'Another guest on this event already has this email address.',
        code: 'GUEST_EMAIL_TAKEN',
      });
    }
    expect((await prisma.guest.findUniqueOrThrow({ where: { id } })).email).toBe(own);

    expect((await updateGuest(ctx.organiser, id, { email: own.toUpperCase(), firstName: 'Same' })).status).toBe(200);
    const free = email();
    expect((await updateGuest(ctx.organiser, id, { email: free })).status).toBe(200);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id } })).email).toBe(free);
  }, 60000);
});

describe('guest update checks only what it changes', () => {
  it('a guest holding both an email and a phone can have their name and plus-ones changed', async () => {
    const ctx = await setup();
    const created = await createGuest(ctx, { email: email() });
    const id = created.body.data.id as string;
    // The second contact arrives at RSVP, as designed.
    await prisma.guest.update({ where: { id }, data: { phoneNumber: phone() } });

    const renamed = await updateGuest(ctx.organiser, id, { firstName: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.firstName).toBe('Renamed');
    const plusOnes = await updateGuest(ctx.organiser, id, { plusOnesAllowed: 2 });
    expect(plusOnes.status).toBe(200);
    expect(plusOnes.body.data.plusOnesAllowed).toBe(2);
  }, 60000);

  it('with sms off, a phone-only guest can have their plus-ones and name changed; a contact change still needs an email', async () => {
    const ctx = await setup();
    const created = await createGuest(ctx, { phoneNumber: phone() });
    const id = created.body.data.id as string;

    vi.stubEnv('FEATURES_DISABLED', 'sms');
    const plusOnes = await updateGuest(ctx.organiser, id, { plusOnesAllowed: 1 });
    expect(plusOnes.status).toBe(200);
    expect(plusOnes.body.data.plusOnesAllowed).toBe(1);
    expect((await updateGuest(ctx.organiser, id, { firstName: 'Renamed' })).status).toBe(200);
    expect((await updateGuest(ctx.organiser, id, { phoneNumber: phone() })).status).toBe(422);
  }, 60000);

  it('a contact change can still never leave a guest with no contact', async () => {
    const ctx = await setup();
    const created = await createGuest(ctx, { email: email() });
    const res = await updateGuest(ctx.organiser, created.body.data.id, { email: null });
    expect(res.status).toBe(422);
  }, 60000);
});

describe('the plus-ones allowance is a whole number from 0 to 20', () => {
  it('on create and update: outside the range, or not a whole number, is 422 with a code; 0 and 20 are accepted', async () => {
    const ctx = await setup();
    for (const bad of [-1, 21, 2.5, 2 ** 31, '3']) {
      const res = await createGuest(ctx, { email: email(), plusOnesAllowed: bad });
      expect(res.status, String(bad)).toBe(422);
      expect(res.body).toMatchObject({ code: 'GUEST_PLUS_ONES_INVALID', message: 'Plus-ones allowed must be a whole number from 0 to 20.' });
    }
    const zero = await createGuest(ctx, { email: email(), plusOnesAllowed: 0 });
    const twenty = await createGuest(ctx, { email: email(), plusOnesAllowed: 20 });
    expect([zero.status, twenty.status]).toEqual([201, 201]);

    const id = zero.body.data.id as string;
    for (const bad of [21, 2 ** 31, -1]) {
      const res = await updateGuest(ctx.organiser, id, { plusOnesAllowed: bad });
      expect(res.status, String(bad)).toBe(422);
      expect(res.body.code).toBe('GUEST_PLUS_ONES_INVALID');
    }
    expect((await prisma.guest.findUniqueOrThrow({ where: { id } })).plusOnesAllowed).toBe(0);
  }, 60000);

  it('on import: a row outside the range is refused and listed; the rest imports', async () => {
    const ctx = await setup();
    const csv = Buffer.from(
      `First Name,Surname,Contact,Day,Plus-Ones Allowed\nOk,Row,${email()},,20\nToo,Many,${email()},,21\nHuge,Row,${email()},,99999999999\n`
    );
    const res = await request(app)
      .post(`/api/events/${ctx.event.id}/guests/import`)
      .set(headersFor(ctx.organiser))
      .attach('file', csv, { filename: 'guests.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 3, created: 1, failed: 2 });
    expect(res.body.data.failures.map((f: { row: number; reason: string }) => f.reason)).toEqual([
      "'21': Plus-ones allowed must be a whole number from 0 to 20.",
      "'99999999999': Plus-ones allowed must be a whole number from 0 to 20.",
    ]);
  }, 60000);
});
