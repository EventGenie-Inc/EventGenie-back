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
      message: "You're registered! We've sent your personal link to thandi.mokoena@example.test.",
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

    const ok = await register(ev.shareToken, {});
    expect(ok.status).toBe(201);
    const invite = await prisma.invite.findFirstOrThrow({ where: { eventId: ev.eventId }, include: { attendances: true } });
    expect(invite.attendances.map((a) => a.eventDayId)).toEqual([ev.dayIds[0]]);
  }, 60000);

  it('plus-ones beyond the allowance are refused, and none are allowed by default', async () => {
    const ev = await createPublicEvent();
    const res = await register(ev.shareToken, { plusOneNames: ['Sipho'] });
    expect(res.status).toBe(422);
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

describe('the same email registering again', () => {
  it('creates no second guest and re-sends that person’s own link, revealing nothing else', async () => {
    const ev = await createPublicEvent();
    expect((await register(ev.shareToken, { firstName: 'Original', email: 'Repeat.Person@Example.test' })).status).toBe(201);

    const again = await register(ev.shareToken, { firstName: 'Impostor', email: '  repeat.person@example.TEST ' });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({
      outcome: 'ALREADY_REGISTERED',
      emailSent: true,
      message: "You're already registered for this event. We've sent your personal link to repeat.person@example.test again.",
    });
    expect(JSON.stringify(again.body)).not.toMatch(/token|Original|guestId/i);

    const guests = await guestsOf(ev.eventId);
    expect(guests).toHaveLength(1);
    expect(guests[0]!.firstName).toBe('Original');

    const token = (await prisma.invite.findFirstOrThrow({ where: { guestId: guests[0]!.id } })).token;
    const emails = sentEmails();
    expect(emails).toHaveLength(2);
    for (const e of emails) {
      expect(e.to).toBe('repeat.person@example.test');
      expect(e.html).toContain(`/rsvp?token=${token}`);
    }
  }, 60000);

  it('still re-sends once registration is full or closed (they are not a new registration)', async () => {
    const ev = await createPublicEvent({ event: { registrationCap: 1 } });
    const email = freshEmail();
    expect((await register(ev.shareToken, { email })).status).toBe(201);
    expect((await register(ev.shareToken, {})).body.code).toBe('REGISTRATION_FULL');
    expect((await register(ev.shareToken, { email })).body.data.outcome).toBe('ALREADY_REGISTERED');

    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationClosesAt: new Date(Date.now() - 1000) } });
    const closed = await register(ev.shareToken, { email });
    expect(closed.status).toBe(200);
    expect(closed.body.data.outcome).toBe('ALREADY_REGISTERED');
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

  it('with publicEvents off, the view and registration are 404', async () => {
    const ev = await createPublicEvent();
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    expect((await view(ev.shareToken)).status).toBe(404);
    expect((await register(ev.shareToken, {})).status).toBe(404);
    expect(await guestsOf(ev.eventId)).toHaveLength(0);
  }, 60000);
});
