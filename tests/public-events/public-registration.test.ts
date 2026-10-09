import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend } from '../setup.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, view, freshEmail, prisma } from './helpers.js';

// ─────────────────────────────────────────
//  PUBLIC SELF-REGISTRATION — POST /api/public-events/:shareToken/register
//
//  A company shares one link; each person who registers becomes a guest
//  with their own accepted invitation, emailed to them. Refusals carry a
//  code: email outside the allowed domains, cap reached (plus-ones
//  counted), registration closed, event cancelled. The same email again is
//  never a second guest: their own link is emailed again.
// ─────────────────────────────────────────

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPublicEventFixtures();
});

const sentEmails = () => mockResendSend.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string; text: string });
const guestsOf = (eventId: string) => prisma.guest.findMany({ where: { eventId, isArchived: false } });

describe('a successful registration', () => {
  it('creates the guest (normalised email, marked self-registered) with an accepted invite, their days and plus-ones, and emails their link', async () => {
    const ev = await createPublicEvent({ days: 3, event: { registrationPlusOnesAllowed: 2 } });
    // Day 3 is not open to registration.
    await prisma.eventDay.update({ where: { id: ev.dayIds[2]! }, data: { openForRegistration: false } });

    const res = await register(ev.shareToken, {
      firstName: '  Thandi ',
      surname: 'Mokoena',
      email: '  Thandi.Mokoena@Example.TEST ',
      phoneNumber: '+27825550101',
      dayIds: [ev.dayIds[1]],
      plusOneNames: ['Sipho'],
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      outcome: 'REGISTERED',
      emailSent: true,
      message: 'Check your email for your e-velope.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    const guests = await prisma.guest.findMany({ where: { eventId: ev.eventId }, include: { invites: { include: { inviteEventDay: true, attendances: true } } } });
    const primary = guests.find((g) => g.hostGuestId === null)!;
    const plusOne = guests.find((g) => g.hostGuestId !== null)!;
    expect(guests).toHaveLength(2);
    expect(primary).toMatchObject({ firstName: 'Thandi', surname: 'Mokoena', email: 'thandi.mokoena@example.test', phoneNumber: '+27825550101', plusOnesAllowed: 2 });
    expect(primary.selfRegisteredAt).toBeInstanceOf(Date);
    expect(plusOne).toMatchObject({ firstName: 'Sipho', email: null, selfRegisteredAt: null });

    const invite = primary.invites[0]!;
    expect(invite).toMatchObject({ status: 'ACCEPTED', used: true, deliveryMethod: 'EMAIL' });
    expect(invite.deliveredAt).toBeInstanceOf(Date);
    // Offered every open day, so they can change their answer later; attending the one they chose.
    expect(invite.inviteEventDay.map((d) => d.eventDayId).sort()).toEqual([ev.dayIds[0], ev.dayIds[1]].sort());
    expect(invite.attendances.map((a) => a.eventDayId)).toEqual([ev.dayIds[1]]);
    expect(plusOne.invites[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(plusOne.invites[0]!.attendances.map((a) => a.eventDayId)).toEqual([ev.dayIds[1]]);

    const [email] = sentEmails();
    expect(sentEmails()).toHaveLength(1);
    expect(email!.to).toBe('thandi.mokoena@example.test');
    expect(email!.subject).toMatch(/^You're registered for Year-end function /);
    expect(email!.html).toContain(`/rsvp?token=${invite.token}`);
    expect(email!.html).toContain('>Open your e-velope</a>');
  }, 60000);

  it('with no dayIds, attends every day open to registration; a closed day is refused', async () => {
    const ev = await createPublicEvent({ days: 2 });
    await prisma.eventDay.update({ where: { id: ev.dayIds[1]! }, data: { openForRegistration: false } });

    const refused = await register(ev.shareToken, { dayIds: [ev.dayIds[1]] });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('REGISTRATION_DAY_NOT_OPEN');

    const ok = await register(ev.shareToken, {});
    expect(ok.status).toBe(201);
    const invite = await prisma.invite.findFirstOrThrow({ where: { eventId: ev.eventId }, include: { attendances: true } });
    expect(invite.attendances.map((a) => a.eventDayId)).toEqual([ev.dayIds[0]]);
  }, 60000);

  it('plus-ones beyond the allowance are refused with their own code, and none are allowed by default', async () => {
    const ev = await createPublicEvent();
    const res = await register(ev.shareToken, { plusOneNames: ['Sipho'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REGISTRATION_TOO_MANY_PLUS_ONES');

    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationPlusOnesAllowed: 1 } });
    const overAllowance = await register(ev.shareToken, { plusOneNames: ['Sipho', 'Kabelo'] });
    expect(overAllowance.status).toBe(422);
    expect(overAllowance.body.code).toBe('REGISTRATION_TOO_MANY_PLUS_ONES');
    expect(await guestsOf(ev.eventId)).toHaveLength(0);
  }, 60000);

  it('the organiser guest list marks the registrant; the check-in roster lists them and their plus-one like anyone else', async () => {
    installFirebaseMock();
    const ev = await createPublicEvent({ event: { registrationPlusOnesAllowed: 1 } });
    expect((await register(ev.shareToken, { firstName: 'Lerato', plusOneNames: ['Kabelo'] })).status).toBe(201);

    const list = await request(app).get(`/api/events/${ev.eventId}/guests`).set(headersFor(ev.organiser));
    expect(list.status).toBe(200);
    const lerato = list.body.data.find((g: { firstName: string }) => g.firstName === 'Lerato');
    const kabelo = list.body.data.find((g: { firstName: string }) => g.firstName === 'Kabelo');
    expect(lerato.selfRegisteredAt).toEqual(expect.any(String));
    expect(kabelo.selfRegisteredAt).toBeNull();
    expect(kabelo.hostGuestId).toBe(lerato.id);

    const roster = await request(app).get(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`).set(headersFor(ev.organiser));
    expect(roster.status).toBe(200);
    expect(roster.body.data.counts.expected).toBe(2);
    expect(roster.body.data.guests.map((g: { name: string }) => g.name).sort()).toEqual(['Kabelo', 'Lerato']);

    const checkIn = await request(app)
      .post(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`)
      .set(headersFor(ev.organiser))
      .send({ guestId: lerato.id });
    expect(checkIn.status).toBe(201);
  }, 60000);
});

describe('allowed email domains', () => {
  it('refuses an email outside the domains (normalised first) and creates nothing', async () => {
    const ev = await createPublicEvent({ event: { registrationEmailDomains: ['company.co.za', 'partner.co.za'] } });

    for (const email of ['someone@gmail.com', 'someone@mail.company.co.za', 'someone@notcompany.co.za']) {
      const res = await register(ev.shareToken, { email });
      expect(res.status, email).toBe(422);
      expect(res.body.code).toBe('REGISTRATION_EMAIL_DOMAIN');
      expect(res.body.message).toBe('Register with an email address at company.co.za or partner.co.za.');
    }
    expect(await guestsOf(ev.eventId)).toHaveLength(0);
    expect(mockResendSend).not.toHaveBeenCalled();

    expect((await register(ev.shareToken, { email: '  Someone@COMPANY.co.za ' })).status).toBe(201);
    expect((await register(ev.shareToken, { email: freshEmail('partner.co.za') })).status).toBe(201);
  }, 60000);

  it('an existing guest outside the domains gets the domain refusal, not a re-send (no oracle)', async () => {
    const ev = await createPublicEvent();
    expect((await register(ev.shareToken, { email: 'person@gmail.com' })).status).toBe(201);
    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationEmailDomains: ['company.co.za'] } });
    mockResendSend.mockClear();

    const res = await register(ev.shareToken, { email: 'person@gmail.com' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REGISTRATION_EMAIL_DOMAIN');
    expect(mockResendSend).not.toHaveBeenCalled();
  }, 60000);
});

describe('the registration cap counts plus-ones', () => {
  it('a party that would pass the cap is refused; at the cap everyone is refused; the view says full', async () => {
    const ev = await createPublicEvent({ event: { registrationCap: 3, registrationPlusOnesAllowed: 2 } });

    expect((await register(ev.shareToken, { plusOneNames: ['A1'] })).status).toBe(201); // 2 seats

    const tooMany = await register(ev.shareToken, { plusOneNames: ['B1', 'B2'] }); // would be 5
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe('REGISTRATION_PARTY_TOO_LARGE');

    expect((await register(ev.shareToken, {})).status).toBe(201); // 3 seats: full

    const full = await register(ev.shareToken, {});
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('REGISTRATION_FULL');
    expect(full.body.message).not.toMatch(/plan|tier|upgrade|limit/i);
    expect(await guestsOf(ev.eventId)).toHaveLength(3);

    const page = await view(ev.shareToken);
    expect(page.body.data.registration).toMatchObject({ isOpen: false, reason: 'FULL' });
  }, 60000);

  it('a declined registrant frees their seats; a registrant adding plus-ones at RSVP past the cap is refused', async () => {
    const ev = await createPublicEvent({ event: { registrationCap: 2, registrationPlusOnesAllowed: 1 } });
    const emailA = freshEmail();
    expect((await register(ev.shareToken, { email: emailA })).status).toBe(201);
    expect((await register(ev.shareToken, {})).status).toBe(201); // full at 2

    const a = await prisma.guest.findFirstOrThrow({ where: { email: emailA }, include: { invites: true } });
    const token = a.invites[0]!.token;

    // Adding a plus-one would make 3.
    const grow = await request(app).post('/api/rsvp/submit').send({ token, attending: true, attendingDayIds: [ev.dayIds[0]], plusOneNames: ['Extra'] });
    expect(grow.status).toBe(409);
    expect(grow.body.code).toBe('REGISTRATION_FULL');

    // Declining frees the seat; someone new can register.
    expect((await request(app).post('/api/rsvp/submit').send({ token, attending: false })).status).toBe(200);
    expect((await register(ev.shareToken, {})).status).toBe(201);
  }, 60000);

  it('the plan’s guest limit also makes registration full, in guest words', async () => {
    const before = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'CELEBRATE' } });
    await prisma.subscriptionTierConfig.upsert({
      where: { tier: 'CELEBRATE' },
      create: { tier: 'CELEBRATE', maxGuestsPerEvent: 1 },
      update: { maxGuestsPerEvent: 1 },
    });
    try {
      const ev = await createPublicEvent();
      await prisma.tenant.update({ where: { id: ev.tenantId }, data: { subscriptionTier: 'CELEBRATE' } });
      expect((await register(ev.shareToken, {})).status).toBe(201);
      const full = await register(ev.shareToken, {});
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('REGISTRATION_FULL');
      expect(full.body.message).not.toMatch(/plan|tier|upgrade|CELEBRATE|limit/i);
    } finally {
      if (before) await prisma.subscriptionTierConfig.update({ where: { tier: 'CELEBRATE' }, data: { maxGuestsPerEvent: before.maxGuestsPerEvent } });
      else await prisma.subscriptionTierConfig.delete({ where: { tier: 'CELEBRATE' } });
    }
  }, 60000);
});

describe('registration closes', () => {
  it('on the organiser’s closing date', async () => {
    const ev = await createPublicEvent({ event: { registrationClosesAt: new Date(Date.now() - 60_000) } });
    const res = await register(ev.shareToken, {});
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('REGISTRATION_CLOSED');
    expect(await guestsOf(ev.eventId)).toHaveLength(0);
    expect((await view(ev.shareToken)).body.data.registration).toMatchObject({ isOpen: false, reason: 'CLOSED' });
  }, 60000);

  it('at the RSVP deadline by default, and never later than it', async () => {
    const past = new Date(Date.now() - 60_000);
    const byDefault = await createPublicEvent({ event: { rsvpDeadline: past } });
    const res = await register(byDefault.shareToken, {});
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('REGISTRATION_CLOSED');

    // A closing date after an already-passed deadline still doesn't reopen it.
    const later = await createPublicEvent({ event: { rsvpDeadline: past, registrationClosesAt: new Date(Date.now() + 86_400_000) } });
    expect((await register(later.shareToken, {})).body.code).toBe('REGISTRATION_CLOSED');
  }, 60000);

  it('is open before the closing date', async () => {
    const ev = await createPublicEvent({ event: { registrationClosesAt: new Date(Date.now() + 86_400_000) } });
    expect((await register(ev.shareToken, {})).status).toBe(201);
  }, 60000);
});

describe('a cancelled event', () => {
  it('refuses registration with its own code, and re-sends nothing to an existing registrant', async () => {
    const ev = await createPublicEvent();
    const email = freshEmail();
    expect((await register(ev.shareToken, { email })).status).toBe(201);
    await prisma.event.update({ where: { id: ev.eventId }, data: { status: 'CANCELLED' } });
    mockResendSend.mockClear();

    for (const body of [{}, { email }]) {
      const res = await register(ev.shareToken, body);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('REGISTRATION_EVENT_CANCELLED');
      expect(res.body.message).toBe('This event has been cancelled.');
    }
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(await guestsOf(ev.eventId)).toHaveLength(1);
    expect((await view(ev.shareToken)).body.data.registration).toMatchObject({ isOpen: false, reason: 'CANCELLED' });
  }, 60000);
});

// ─────────────────────────────────────────
//  PRIVACY — the same email registering again gets exactly the answer a
//  new registration gets (status, outcome, message, byte for byte), so
//  the page can't be used to test addresses against the guest list. Only
//  the email differs: "Here's your link again" instead of "You're
//  registered", to that address alone.
// ─────────────────────────────────────────
describe('the same email registering again', () => {
  it('gets a response byte-identical to a new registration, creates no second guest, and is emailed their own link again', async () => {
    const ev = await createPublicEvent();
    const first = await register(ev.shareToken, { firstName: 'Original', email: 'Repeat.Person@Example.test' });
    const again = await register(ev.shareToken, { firstName: 'Impostor', email: '  repeat.person@example.TEST ' });
    const stranger = await register(ev.shareToken, { firstName: 'Someone', email: freshEmail() });

    expect(first.status).toBe(201);
    expect(again.status).toBe(first.status);
    expect(again.text).toBe(first.text);
    expect(stranger.text).toBe(first.text);
    expect(first.body).toEqual({
      status: 'ok',
      data: { outcome: 'REGISTERED', emailSent: true, message: 'Check your email for your e-velope.' },
    });

    const guests = await prisma.guest.findMany({ where: { eventId: ev.eventId, email: 'repeat.person@example.test' } });
    expect(guests).toHaveLength(1);
    expect(guests[0]!.firstName).toBe('Original');

    const token = (await prisma.invite.findFirstOrThrow({ where: { guestId: guests[0]!.id } })).token;
    const toThem = sentEmails().filter((e) => e.to === 'repeat.person@example.test');
    expect(toThem.map((e) => e.subject)).toEqual([
      expect.stringMatching(/^You're registered for /),
      expect.stringMatching(/^Your link for /),
    ]);
    for (const e of toThem) expect(e.html).toContain(`/rsvp?token=${token}`);
    expect(toThem[1]!.text).toContain("Here's your link again");
  }, 60000);

  it('once full or closed, gets the same refusal a new registration gets, byte for byte, and is still sent their link', async () => {
    const ev = await createPublicEvent({ event: { registrationCap: 1 } });
    const email = freshEmail();
    expect((await register(ev.shareToken, { email })).status).toBe(201);

    const fullNew = await register(ev.shareToken, {});
    mockResendSend.mockClear();
    const fullRepeat = await register(ev.shareToken, { email });
    expect(fullNew.status).toBe(409);
    expect(fullNew.body.code).toBe('REGISTRATION_FULL');
    expect(fullRepeat.status).toBe(fullNew.status);
    expect(fullRepeat.text).toBe(fullNew.text);
    expect(sentEmails().map((e) => e.to)).toEqual([email]);

    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationClosesAt: new Date(Date.now() - 1000) } });
    const closedNew = await register(ev.shareToken, {});
    mockResendSend.mockClear();
    const closedRepeat = await register(ev.shareToken, { email });
    expect(closedNew.status).toBe(410);
    expect(closedNew.body.code).toBe('REGISTRATION_CLOSED');
    expect(closedRepeat.text).toBe(closedNew.text);
    expect(sentEmails().map((e) => e.to)).toEqual([email]);
  }, 60000);

  it('a form a new registration would be refused for is refused the same way, and nothing is sent', async () => {
    const ev = await createPublicEvent();
    const email = freshEmail();
    expect((await register(ev.shareToken, { email })).status).toBe(201);
    mockResendSend.mockClear();

    const fresh = await register(ev.shareToken, { plusOneNames: ['Sipho'] });
    const repeat = await register(ev.shareToken, { email, plusOneNames: ['Sipho'] });
    expect(fresh.body.code).toBe('REGISTRATION_TOO_MANY_PLUS_ONES');
    expect(repeat.status).toBe(fresh.status);
    expect(repeat.text).toBe(fresh.text);
    expect(mockResendSend).not.toHaveBeenCalled();
  }, 60000);

  it('every invite archived by the organiser: the same answer as anyone, nothing sent, nothing re-created', async () => {
    const ev = await createPublicEvent();
    const email = freshEmail();
    const first = await register(ev.shareToken, { email });
    await prisma.invite.updateMany({ where: { eventId: ev.eventId }, data: { isArchived: true } });
    mockResendSend.mockClear();

    const again = await register(ev.shareToken, { email });
    expect(again.status).toBe(first.status);
    expect(again.text).toBe(first.text);
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(await prisma.invite.count({ where: { eventId: ev.eventId, isArchived: false } })).toBe(0);
  }, 60000);
});

describe('the form itself', () => {
  it('email is required (with sms on too), a bad phone is a coded 422, a private event’s link is a 404', async () => {
    const ev = await createPublicEvent();
    vi.stubEnv('FEATURES_DISABLED', '');
    const noEmail = await register(ev.shareToken, { email: undefined, phoneNumber: '+27825550102' });
    expect(noEmail.status).toBe(422);
    expect(noEmail.body.code).toBe('GUEST_EMAIL_REQUIRED');

    const badPhone = await register(ev.shareToken, { phoneNumber: '0825550102' });
    expect(badPhone.status).toBe(422);
    expect(badPhone.body.code).toBe('CONTACT_PHONE_NOT_INTERNATIONAL');

    expect((await register(ev.shareToken, { firstName: '  ' })).status).toBe(422);
    expect(await guestsOf(ev.eventId)).toHaveLength(0);

    await prisma.event.update({ where: { id: ev.eventId }, data: { visibility: 'PRIVATE' } });
    expect((await register(ev.shareToken, {})).status).toBe(404);
    expect((await view(ev.shareToken)).status).toBe(404);
  }, 60000);

  it('a name that is too long is refused with a code naming its field', async () => {
    const ev = await createPublicEvent({ event: { registrationPlusOnesAllowed: 1 } });
    const long = 'a'.repeat(101);
    const cases: [Record<string, unknown>, string][] = [
      [{ firstName: long }, 'REGISTRATION_FIRST_NAME_TOO_LONG'],
      [{ surname: long }, 'REGISTRATION_SURNAME_TOO_LONG'],
      [{ plusOneNames: [long] }, 'REGISTRATION_PLUS_ONE_NAME_TOO_LONG'],
    ];
    for (const [body, code] of cases) {
      const res = await register(ev.shareToken, body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
    }
    // 100 is the limit, not over it.
    expect((await register(ev.shareToken, { firstName: 'a'.repeat(100) })).status).toBe(201);
  }, 60000);

  it('a blank name, a bad email, no days and a blank plus-one name each carry their own code', async () => {
    const ev = await createPublicEvent({ event: { registrationPlusOnesAllowed: 1 } });
    const cases: [Record<string, unknown>, string][] = [
      [{ firstName: '  ' }, 'REGISTRATION_FIRST_NAME_REQUIRED'],
      [{ email: 'not-an-email' }, 'REGISTRATION_EMAIL_INVALID'],
      [{ dayIds: [] }, 'REGISTRATION_NO_DAYS_CHOSEN'],
      [{ plusOneNames: ['  '] }, 'REGISTRATION_PLUS_ONE_NAME_REQUIRED'],
    ];
    for (const [body, code] of cases) {
      const res = await register(ev.shareToken, body);
      expect(res.status, code).toBe(422);
      expect(res.body.code).toBe(code);
    }
    expect(await guestsOf(ev.eventId)).toHaveLength(0);
  }, 60000);

  it('with publicEvents off, the view and registration are 404', async () => {
    const ev = await createPublicEvent();
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    expect((await view(ev.shareToken)).status).toBe(404);
    expect((await register(ev.shareToken, {})).status).toBe(404);
    expect(await guestsOf(ev.eventId)).toHaveLength(0);
  }, 60000);
});

// ─────────────────────────────────────────
//  PHONES AREN'T UNIQUE — a phone is never anyone's identity. A registrant
//  whose phone another guest already has is registered with it, and the
//  answer is byte for byte what any registration gets.
// ─────────────────────────────────────────
describe('a phone another guest on the event has', () => {
  it('is saved for the registrant too, with the same answer as any registration; the other guest is untouched', async () => {
    const ev = await createPublicEvent();
    const sharedPhone = '+27825550199';
    const other = await prisma.guest.create({
      data: { eventId: ev.eventId, firstName: 'Nomsa', email: freshEmail(), phoneNumber: sharedPhone },
    });
    const otherBefore = await prisma.guest.findUniqueOrThrow({ where: { id: other.id } });

    const control = await register(ev.shareToken, { phoneNumber: '+27825550198' });
    mockResendSend.mockClear();
    const probeEmail = freshEmail();
    const probe = await register(ev.shareToken, { email: probeEmail, phoneNumber: sharedPhone });

    expect(probe.status).toBe(201);
    expect(probe.text).toBe(control.text);
    expect(probe.text).not.toContain(sharedPhone);

    const registrant = await prisma.guest.findFirstOrThrow({ where: { eventId: ev.eventId, email: probeEmail } });
    expect(registrant.phoneNumber).toBe(sharedPhone);

    expect(sentEmails().map((e) => e.to)).toEqual([probeEmail]);
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: other.id } })).toEqual(otherBefore);
    expect(await prisma.invite.count({ where: { guestId: other.id } })).toBe(0);
  }, 60000);
});
