import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock, createTenant, createActor, createEventWithDay, assign, deleteTenantsDeep, type Actor } from '../helpers/team.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, freshEmail } from '../public-events/helpers.js';
import { createCustomTier, onCustomTier, deleteCustomTierFixtures } from '../custom-tiers/custom-tier-fixtures.js';
import { buildPassPayload, assertCheckInQrSecretConfigured, verifyPassPayload } from '../../src/modules/check-in-pass/check-in-pass-token.util.js';
import { checkInPassRepository } from '../../src/modules/check-in-pass/check-in-pass.repository.js';
import { checkInRepository } from '../../src/modules/check-in/check-in.repository.js';
import { scrubText } from '../../src/shared/monitoring/sentry-scrub.js';
import { buildInviteRsvpLink } from '../../src/modules/invite/invite-message.util.js';
import { shortLinkFor } from '../../src/modules/invite/invite-short-code.service.js';
import prisma from '../../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  QR CHECK-IN (check-in-pass module)
//
//  Accepted guests and each plus-one get a pass per day they attend that has
//  a venue; door staff scan its signed payload. A pass is only a
//  credential: a scan writes the same CheckIn row as the guest list.
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });

const tenantIds: string[] = [];
const customTierIds: string[] = [];

beforeEach(() => installFirebaseMock());

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await deleteCustomTierFixtures({ tenantIds, customTierIds: customTierIds.splice(0) });
  if (tenantIds.length) await deleteTenantsDeep(tenantIds.splice(0));
  await cleanupPublicEventFixtures();
});

type DayType = 'VENUE' | 'ONLINE';

// A published event with two days (venue unless asked), an organiser, and a
// guest invited to both who may bring two plus-ones, with an email, a phone
// and an RSVP question, none of which a scan may return.
const setup = async (dayTypes: [DayType, DayType] = ['VENUE', 'VENUE']) => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event, day } = await createEventWithDay(tenant.id, organiser.id, `QR Event ${randomUUID()}`);
  const day2 = await prisma.eventDay.create({
    data: { eventId: event.id, label: 'Day 2', date: new Date('2027-03-02'), location: 'Second Venue', address: '2 Test Road', createdBy: organiser.id, updatedBy: organiser.id },
  });
  for (const [d, type] of [[day, dayTypes[0]], [day2, dayTypes[1]]] as const) {
    if (type === 'ONLINE') {
      await prisma.eventDay.update({ where: { id: d.id }, data: { locationType: 'ONLINE', onlineUrl: 'https://meet.example.test/x', location: null, address: null } });
    }
  }
  const field = await prisma.rsvpField.create({
    data: { eventId: event.id, label: 'Dietary needs', fieldType: 'TEXT', isRequired: false, order: 1, createdBy: organiser.id, updatedBy: organiser.id },
  });
  const guest = await prisma.guest.create({
    data: { eventId: event.id, firstName: 'Thandi', surname: 'Nkosi', email: `thandi-${randomUUID()}@test.invalid`, phoneNumber: '+27821234567', plusOnesAllowed: 2 },
  });
  const invite = await prisma.invite.create({
    data: {
      eventId: event.id,
      guestId: guest.id,
      token: randomBytes(32).toString('hex'),
      deliveryMethod: 'EMAIL',
      createdBy: organiser.id,
      updatedBy: organiser.id,
      inviteEventDay: { create: [{ eventDayId: day.id }, { eventDayId: day2.id }] },
    },
  });
  return { tenant, organiser, event, day, day2, guest, invite, field };
};

type Fixture = Awaited<ReturnType<typeof setup>>;

const submit = (token: string, body: Record<string, unknown>) => request(app).post('/api/rsvp/submit').send({ token, ...body });
const accept = (f: Fixture, dayIds: string[], plusOneNames: string[] = []) =>
  submit(f.invite.token, { attending: true, attendingDayIds: dayIds, plusOneNames, rsvpResponses: [{ rsvpFieldId: f.field.id, value: 'Vegetarian, no nuts' }] });
const passesFor = (token: string) => request(app).post('/api/rsvp/passes').send({ token });
const scan = (actor: Actor | null, eventId: string, eventDayId: string, payload: unknown) => {
  const req = request(app).post(`/api/events/${eventId}/check-in/scan`);
  return (actor ? req.set(headersFor(actor)) : req).send({ eventDayId, payload });
};
const activePasses = (guestId: string) =>
  prisma.checkInPass.findMany({ where: { guestId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
const payloadOf = (pass: { id: string; kind: 'RSVP' }) => buildPassPayload(pass);
const personKey = (p: { eventDayId: string; plusOneGuestId: string | null; guestId: string }) => `${p.eventDayId}:${p.plusOneGuestId ?? p.guestId}`;

describe('issuing passes', () => {
  it('issues one pass per person per attending day on accepting, a plus-one included', async () => {
    const f = await setup();
    expect((await accept(f, [f.day.id, f.day2.id], ['Sipho'])).status).toBe(200);

    const plusOne = await prisma.guest.findFirstOrThrow({ where: { hostGuestId: f.guest.id, isArchived: false } });
    const active = await activePasses(f.guest.id);
    expect(active.map(personKey).sort()).toEqual(
      [`${f.day.id}:${f.guest.id}`, `${f.day2.id}:${f.guest.id}`, `${f.day.id}:${plusOne.id}`, `${f.day2.id}:${plusOne.id}`].sort()
    );
    expect(active.every((p) => p.kind === 'RSVP' && p.eventId === f.event.id)).toBe(true);

    const page = await passesFor(f.invite.token);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body.data.passes).toHaveLength(4);
    for (const pass of page.body.data.passes) {
      expect(Object.keys(pass).sort()).toEqual(['day', 'isPlusOne', 'payload', 'personName']);
      expect(Object.keys(pass.day).sort()).toEqual(['date', 'id', 'label']);
      expect(verifyPassPayload(pass.payload)).not.toBeNull();
    }
    expect(page.body.data.passes.map((p: { personName: string; isPlusOne: boolean; day: { label: string } }) => `${p.day.label}/${p.personName}/${p.isPlusOne}`).sort()).toEqual(
      ['Day 1/Sipho/true', 'Day 1/Thandi Nkosi/false', 'Day 2/Sipho/true', 'Day 2/Thandi Nkosi/false']
    );
  });

  it('revokes old passes when days change, plus-ones change or the guest declines; old codes scan REVOKED', async () => {
    const f = await setup();
    await accept(f, [f.day.id, f.day2.id], ['Sipho']);
    const first = await activePasses(f.guest.id);
    const firstPlusOne = await prisma.guest.findFirstOrThrow({ where: { hostGuestId: f.guest.id, isArchived: false } });
    const guestDay2 = first.find((p) => p.eventDayId === f.day2.id && p.plusOneGuestId === null)!;
    const guestDay1 = first.find((p) => p.eventDayId === f.day.id && p.plusOneGuestId === null)!;
    const plusOneDay1 = first.find((p) => p.eventDayId === f.day.id && p.plusOneGuestId === firstPlusOne.id)!;

    // Different days and a different plus-one.
    expect((await accept(f, [f.day.id], ['Lerato'])).status).toBe(200);
    const second = await activePasses(f.guest.id);
    const lerato = await prisma.guest.findFirstOrThrow({ where: { hostGuestId: f.guest.id, isArchived: false } });
    expect(second.map(personKey).sort()).toEqual([`${f.day.id}:${f.guest.id}`, `${f.day.id}:${lerato.id}`].sort());
    // The day kept keeps its code; the dropped day and the replaced plus-one are revoked.
    expect(second.some((p) => p.id === guestDay1.id)).toBe(true);
    const revoked = await prisma.checkInPass.findMany({ where: { id: { in: [guestDay2.id, plusOneDay1.id] } } });
    expect(revoked.map((p) => [p.status, p.revokeReason, p.revokedAt !== null])).toEqual([
      ['REVOKED', 'RSVP_CHANGED', true],
      ['REVOKED', 'RSVP_CHANGED', true],
    ]);
    const droppedDay = await scan(f.organiser, f.event.id, f.day2.id, payloadOf(guestDay2));
    expect(droppedDay.body.data).toMatchObject({ result: 'RED', reason: 'REVOKED', message: 'This code is no longer valid.', person: null });
    // Sipho swapped for Lerato: one plus-one replaced by one, which the count
    // rule reads as replaced (it can't tell a swap from a re-created row).
    const oldPlusOne = await scan(f.organiser, f.event.id, f.day.id, payloadOf(plusOneDay1));
    expect(oldPlusOne.body.data).toMatchObject({ result: 'RED', reason: 'REPLACED', person: null });

    // Declining revokes everything.
    expect((await submit(f.invite.token, { attending: false })).status).toBe(200);
    expect(await activePasses(f.guest.id)).toHaveLength(0);
    expect((await prisma.checkInPass.findUniqueOrThrow({ where: { id: guestDay1.id } })).revokeReason).toBe('DECLINED');
    const declined = await scan(f.organiser, f.event.id, f.day.id, payloadOf(guestDay1));
    expect(declined.body.data).toMatchObject({ result: 'RED', reason: 'REVOKED' });
    expect((await passesFor(f.invite.token)).body.data.passes).toEqual([]);
  });

  it('leaves removed guests, archived invites and pending registrations with no active passes; approving issues them', async () => {
    const f = await setup();
    await accept(f, [f.day.id], ['Sipho']);
    expect(await activePasses(f.guest.id)).toHaveLength(2);
    const before = (await activePasses(f.guest.id))[0]!;

    // Removing the guest.
    expect((await request(app).delete(`/api/guests/${f.guest.id}`).set(headersFor(f.organiser))).status).toBe(200);
    expect(await activePasses(f.guest.id)).toHaveLength(0);
    expect((await scan(f.organiser, f.event.id, before.eventDayId, payloadOf(before))).body.data.reason).toBe('REVOKED');
    // Restoring brings codes back.
    expect((await request(app).post(`/api/guests/${f.guest.id}/reactivate`).set(headersFor(f.organiser))).status).toBe(200);
    expect((await activePasses(f.guest.id)).length).toBeGreaterThan(0);

    // Archiving the invite (guest kept).
    expect((await request(app).delete(`/api/events/${f.event.id}/invites/${f.invite.id}`).set(headersFor(f.organiser))).status).toBe(200);
    expect(await activePasses(f.guest.id)).toHaveLength(0);

    // A registration awaiting approval: nothing until approved.
    const ev = await createPublicEvent({ event: { registrationAutoApprove: false, registrationPlusOnesAllowed: 1 } });
    const email = freshEmail();
    expect((await register(ev.shareToken, { email, plusOneNames: ['Sipho'] })).status).toBe(201);
    const registrant = await prisma.guest.findFirstOrThrow({ where: { eventId: ev.eventId, email }, include: { invites: true } });
    expect(registrant.pendingApproval).toBe(true);
    expect(await activePasses(registrant.id)).toHaveLength(0);
    expect((await passesFor(registrant.invites[0]!.token)).status).toBe(404);

    const approved = await request(app).post(`/api/events/${ev.eventId}/registrations/${registrant.id}/approve`).set(headersFor(ev.organiser));
    expect(approved.status).toBe(200);
    const issued = await activePasses(registrant.id);
    expect(issued).toHaveLength(2);
    expect(issued.filter((p) => p.plusOneGuestId !== null)).toHaveLength(1);
  });

  it('issues nothing for online days: none on an online event, only the venue day on a hybrid one', async () => {
    const online = await setup(['ONLINE', 'ONLINE']);
    await accept(online, [online.day.id, online.day2.id], ['Sipho']);
    expect(await activePasses(online.guest.id)).toHaveLength(0);
    expect((await passesFor(online.invite.token)).body.data.passes).toEqual([]);

    const hybrid = await setup(['ONLINE', 'VENUE']);
    await accept(hybrid, [hybrid.day.id, hybrid.day2.id]);
    const passes = await activePasses(hybrid.guest.id);
    expect(passes.map((p) => p.eventDayId)).toEqual([hybrid.day2.id]);
  });

  it('issues lazily for a guest who accepted before passes existed, once per person per day under concurrent loads', async () => {
    const f = await setup();
    // Accepted the old way: no passes were ever issued.
    await prisma.invite.update({ where: { id: f.invite.id }, data: { status: 'ACCEPTED', used: true, usedAt: new Date() } });
    await prisma.attendance.createMany({ data: [{ inviteId: f.invite.id, eventDayId: f.day.id }, { inviteId: f.invite.id, eventDayId: f.day2.id }] });
    const plusOne = await prisma.guest.create({ data: { eventId: f.event.id, firstName: 'Sipho', hostGuestId: f.guest.id } });
    const plusOneInvite = await prisma.invite.create({
      data: {
        eventId: f.event.id, guestId: plusOne.id, token: randomBytes(32).toString('hex'), status: 'ACCEPTED', used: true,
        deliveryMethod: 'EMAIL', createdBy: 'guest-rsvp', updatedBy: 'guest-rsvp',
        inviteEventDay: { create: [{ eventDayId: f.day.id }, { eventDayId: f.day2.id }] },
      },
    });
    await prisma.attendance.createMany({ data: [{ inviteId: plusOneInvite.id, eventDayId: f.day.id }, { inviteId: plusOneInvite.id, eventDayId: f.day2.id }] });
    expect(await prisma.checkInPass.count({ where: { guestId: f.guest.id } })).toBe(0);

    const loads = await Promise.all([passesFor(f.invite.token), passesFor(f.invite.token), passesFor(f.invite.token)]);
    for (const load of loads) {
      expect(load.status).toBe(200);
      expect(load.body.data.passes).toHaveLength(4);
    }
    // Every load shows the same codes, and the database holds exactly one per person per day.
    const sets = loads.map((l) => l.body.data.passes.map((p: { payload: string }) => p.payload).sort().join());
    expect(new Set(sets).size).toBe(1);
    expect(await prisma.checkInPass.count({ where: { guestId: f.guest.id } })).toBe(4);
    const active = await activePasses(f.guest.id);
    expect(new Set(active.map(personKey)).size).toBe(4);

    // The database itself refuses a second active pass for the same person and day.
    await expect(
      prisma.checkInPass.create({ data: { eventId: f.event.id, eventDayId: f.day.id, guestId: f.guest.id, kind: 'RSVP' } })
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('scanning', () => {
  const acceptedGuest = async (dayTypes?: [DayType, DayType]) => {
    const f = await setup(dayTypes);
    await accept(f, [f.day.id, f.day2.id], ['Sipho']);
    const active = await activePasses(f.guest.id);
    const guestPass = active.find((p) => p.eventDayId === f.day.id && p.plusOneGuestId === null)!;
    const plusOnePass = active.find((p) => p.eventDayId === f.day.id && p.plusOneGuestId !== null)!;
    return { ...f, guestPass, plusOnePass };
  };

  it('answers INVALID for a tampered signature, another secret, garbage and an unknown pass', async () => {
    const f = await acceptedGuest();
    const good = payloadOf(f.guestPass);
    const [prefix, id, sig] = good.split('.') as [string, string, string];
    const flipped = `${prefix}.${id}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;

    vi.stubEnv('CHECKIN_QR_SECRET', 'a-completely-different-secret-value-9876543210');
    const otherSecret = buildPassPayload(f.guestPass);
    vi.unstubAllEnvs();
    expect(otherSecret).not.toBe(good);

    const unknown = buildPassPayload({ id: 'c' + randomBytes(12).toString('hex'), kind: 'RSVP' });
    const cases: unknown[] = [flipped, otherSecret, 'hello world', '', 'EV1..', `XX9.${id}.${sig}`, 12345, null, unknown, `${good}.extra`, 'x'.repeat(5000)];
    for (const payload of cases) {
      const res = await scan(f.organiser, f.event.id, f.day.id, payload);
      expect(res.status, String(payload).slice(0, 40)).toBe(200);
      expect(res.body.data).toEqual({
        result: 'RED', reason: 'INVALID', message: "This code isn't a valid check-in code.",
        person: null, day: null, table: null, checkedInAt: null, checkedInBy: null,
      });
    }
    // Nothing was checked in by any of them, and the real code still works.
    expect(await prisma.checkIn.count({ where: { inviteId: f.invite.id } })).toBe(0);
    expect((await scan(f.organiser, f.event.id, f.day.id, good)).body.data.result).toBe('GREEN');
  });

  it('answers WRONG_EVENT without naming the other event, WRONG_DAY naming the right day, and EVENT_CANCELLED', async () => {
    const f = await acceptedGuest();
    const { event: other, day: otherDay } = await createEventWithDay(f.tenant.id, f.organiser.id, `Secret Gala ${randomUUID()}`);

    const wrongEvent = await scan(f.organiser, other.id, otherDay.id, payloadOf(f.guestPass));
    expect(wrongEvent.body.data).toEqual({
      result: 'RED', reason: 'WRONG_EVENT', message: 'This code is for a different event.',
      person: null, day: null, table: null, checkedInAt: null, checkedInBy: null,
    });
    const text = JSON.stringify(wrongEvent.body);
    for (const leak of [f.event.id, f.event.name, f.tenant.id, f.tenant.name, 'Thandi']) expect(text).not.toContain(leak);

    const wrongDay = await scan(f.organiser, f.event.id, f.day2.id, payloadOf(f.guestPass));
    expect(wrongDay.body.data).toMatchObject({
      result: 'RED', reason: 'WRONG_DAY', message: 'This code is for Day 1.',
      day: { id: f.day.id, label: 'Day 1' }, person: { name: 'Thandi Nkosi', isPlusOne: false },
    });
    expect(await prisma.checkIn.count({ where: { inviteId: f.invite.id } })).toBe(0);

    await prisma.event.update({ where: { id: f.event.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    const cancelled = await scan(f.organiser, f.event.id, f.day.id, payloadOf(f.guestPass));
    expect(cancelled.body.data).toMatchObject({ result: 'RED', reason: 'EVENT_CANCELLED', person: null });
  });

  it('gives exactly one GREEN and one AMBER for two scans at once, recording one check-in', async () => {
    const f = await acceptedGuest();
    const second = await createActor('EVENT_ADMIN', f.tenant.id);
    const payload = payloadOf(f.plusOnePass);
    // Force the race: both scans have read "not checked in yet" before either
    // writes, so only the database's unique (invite, day) row can decide.
    const realRead = checkInRepository.findGuestInvites;
    const parked: (() => void)[] = [];
    let reads = 0;
    vi.spyOn(checkInRepository, 'findGuestInvites').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      const rows = await realRead(...args);
      reads += 1;
      if (reads <= 2) {
        await new Promise<void>((resolve) => {
          parked.push(resolve);
          if (parked.length === 2) parked.forEach((release) => release());
          setTimeout(resolve, 10_000);
        });
      }
      return rows;
    }) as unknown as typeof realRead);
    const [a, b] = await Promise.all([scan(f.organiser, f.event.id, f.day.id, payload), scan(second, f.event.id, f.day.id, payload)]);
    expect(reads).toBeGreaterThanOrEqual(3); // both parked reads, then the loser's re-read
    expect([a.status, b.status]).toEqual([200, 200]);
    const results = [a.body.data.result, b.body.data.result].sort();
    expect(results).toEqual(['AMBER', 'GREEN']);
    const green = [a, b].find((r) => r.body.data.result === 'GREEN')!.body.data;
    expect(green).toMatchObject({
      reason: null, message: `Checked in: Sipho (guest of Thandi Nkosi)`, table: null,
      person: { guestId: f.plusOnePass.plusOneGuestId, name: 'Sipho', isPlusOne: true, guestOf: 'Thandi Nkosi' },
      day: { id: f.day.id, label: 'Day 1' },
    });
    const amber = [a, b].find((r) => r.body.data.result === 'AMBER')!.body.data;
    expect(amber.checkedInAt).toBe(green.checkedInAt);
    expect(await prisma.checkIn.count({ where: { invite: { guestId: f.plusOnePass.plusOneGuestId! }, eventDayId: f.day.id } })).toBe(1);
  });

  it('agrees with the guest list both ways: a scan shows as checked in, a list check-in makes the scan AMBER', async () => {
    const f = await acceptedGuest();
    const green = await scan(f.organiser, f.event.id, f.day.id, payloadOf(f.guestPass));
    expect(green.body.data.result).toBe('GREEN');
    const roster = await request(app).get(`/api/events/${f.event.id}/check-in/days/${f.day.id}`).set(headersFor(f.organiser));
    const row = roster.body.data.guests.find((g: { guestId: string }) => g.guestId === f.guest.id);
    expect(row).toMatchObject({ checkedIn: true, checkedInAt: green.body.data.checkedInAt });

    // The plus-one checked in from the list, by another staff member.
    const staff = await createActor('EVENT_ADMIN', f.tenant.id);
    const listed = await request(app)
      .post(`/api/events/${f.event.id}/check-in/days/${f.day.id}`)
      .set(headersFor(staff))
      .send({ guestId: f.plusOnePass.plusOneGuestId });
    expect(listed.status).toBe(201);
    const amber = await scan(f.organiser, f.event.id, f.day.id, payloadOf(f.plusOnePass));
    expect(amber.body.data).toMatchObject({ result: 'AMBER', reason: null, checkedInBy: staff.username, checkedInAt: listed.body.data.guest.checkedInAt });
    expect(amber.body.data.message).toMatch(new RegExp(`^Already checked in at \\d{2}:\\d{2} by ${staff.username}: Sipho \\(guest of Thandi Nkosi\\)$`));
  });

  it('undoes a scanned check-in through the existing undo, after which the next scan is GREEN again', async () => {
    const f = await acceptedGuest();
    const payload = payloadOf(f.guestPass);
    const first = await scan(f.organiser, f.event.id, f.day.id, payload);
    expect(first.body.data.result).toBe('GREEN');
    const undo = await request(app)
      .delete(`/api/events/${f.event.id}/check-in/days/${f.day.id}/guests/${first.body.data.person.guestId}`)
      .set(headersFor(f.organiser));
    expect(undo.body.data.removed).toBe(true);
    expect(await prisma.checkIn.count({ where: { inviteId: f.invite.id } })).toBe(0);
    expect((await scan(f.organiser, f.event.id, f.day.id, payload)).body.data.result).toBe('GREEN');
  });

  it('refuses a locked member not assigned to the event, another tenant, and an unauthenticated request', async () => {
    const f = await acceptedGuest();
    const payload = payloadOf(f.guestPass);
    const { event: elsewhere } = await createEventWithDay(f.tenant.id, f.organiser.id, `Elsewhere ${randomUUID()}`);
    const locked = await createActor('EVENT_ADMIN', f.tenant.id);
    await assign(f.tenant.id, locked.id, elsewhere.id, f.organiser.id);
    const otherTenant = await createTenant();
    tenantIds.push(otherTenant.id);
    const stranger = await createActor('TENANT_ADMIN', otherTenant.id);

    const notAllowed = {
      result: 'RED', reason: 'NOT_ALLOWED', message: "You don't have access to check guests in for this event.",
      person: null, day: null, table: null, checkedInAt: null, checkedInBy: null,
    };
    expect((await scan(locked, f.event.id, f.day.id, payload)).body.data).toEqual(notAllowed);
    expect((await scan(stranger, f.event.id, f.day.id, payload)).body.data).toEqual(notAllowed);
    // The same answer for an event that doesn't exist: nothing to tell apart.
    expect((await scan(stranger, 'c' + randomBytes(12).toString('hex'), f.day.id, payload)).body.data).toEqual(notAllowed);
    expect((await scan(null, f.event.id, f.day.id, payload)).status).toBe(401);
    expect(await prisma.checkIn.count({ where: { inviteId: f.invite.id } })).toBe(0);

    // Control: assigned, the same member scans.
    await assign(f.tenant.id, locked.id, f.event.id, f.organiser.id);
    expect((await scan(locked, f.event.id, f.day.id, payload)).body.data.result).toBe('GREEN');
  });

  it('never returns the guest\'s email, phone or answers, and never logs a payload', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')); });
    }
    const f = await acceptedGuest();
    const payload = payloadOf(f.guestPass);
    // A failing sync on the page logs; it must log ids only.
    vi.spyOn(checkInPassRepository, 'createMissing').mockRejectedValueOnce(new Error(`boom ${payload}`));
    const page = await passesFor(f.invite.token);
    expect(page.status).toBe(200);

    const results = [
      await scan(f.organiser, f.event.id, f.day.id, payload),
      await scan(f.organiser, f.event.id, f.day.id, payload),
      await scan(f.organiser, f.event.id, f.day2.id, payload),
      await scan(f.organiser, f.event.id, f.day.id, `${payload.slice(0, -2)}xx`),
    ];
    expect(results.map((r) => r.body.data.result)).toEqual(['GREEN', 'AMBER', 'RED', 'RED']);
    for (const res of results) {
      expect(Object.keys(res.body.data).sort()).toEqual(['checkedInAt', 'checkedInBy', 'day', 'message', 'person', 'reason', 'result', 'table']);
      if (res.body.data.person) expect(Object.keys(res.body.data.person).sort()).toEqual(['guestId', 'guestOf', 'isPlusOne', 'name']);
      const text = JSON.stringify(res.body);
      for (const secret of [f.guest.email!, f.guest.phoneNumber!, '821234567', 'Vegetarian', f.invite.token]) expect(text).not.toContain(secret);
    }
    const [, , sig] = payload.split('.');
    for (const line of logged) {
      expect(line).not.toContain(payload);
      expect(line).not.toContain(sig!);
    }
    // Sentry masks a payload wherever one appears in text.
    expect(scrubText(`scan failed for ${payload} at the door`)).toBe('scan failed for [checkin-code] at the door');
  });
});

describe('switching QR check-in off', () => {
  it('flag off: scanning and the passes page are 404, nothing is issued, and the guest-list check-in still works', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'qrCheckIn');
    const f = await setup();
    await accept(f, [f.day.id]);
    expect(await prisma.checkInPass.count({ where: { guestId: f.guest.id } })).toBe(0);
    const payload = buildPassPayload({ id: 'c' + randomBytes(12).toString('hex'), kind: 'RSVP' });
    expect((await scan(f.organiser, f.event.id, f.day.id, payload)).status).toBe(404);
    expect((await passesFor(f.invite.token)).status).toBe(404);
    const listed = await request(app).post(`/api/events/${f.event.id}/check-in/days/${f.day.id}`).set(headersFor(f.organiser)).send({ guestId: f.guest.id });
    expect(listed.status).toBe(201);
  });

  it('plan setting off: scanning is refused with a reason, no passes are issued or shown, and the guest-list check-in still works', async () => {
    const f = await setup();
    await accept(f, [f.day.id]);
    const pass = (await activePasses(f.guest.id))[0]!;

    const tier = await createCustomTier({ qrCheckInEnabled: false });
    customTierIds.push(tier.id);
    await onCustomTier(f.tenant.id, tier.id);

    const refused = await scan(f.organiser, f.event.id, f.day.id, payloadOf(pass));
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('QR_CHECK_IN_UNAVAILABLE');
    expect(refused.body.message).toBe(`QR check-in isn't available on your ${tier.name} plan. Contact us at admin@e-velope.co.za if you need it.`);
    expect((await passesFor(f.invite.token)).body.data.passes).toEqual([]);

    // A change of RSVP issues nothing new.
    await accept(f, [f.day.id, f.day2.id]);
    expect(await activePasses(f.guest.id)).toHaveLength(1);

    const listed = await request(app).post(`/api/events/${f.event.id}/check-in/days/${f.day.id}`).set(headersFor(f.organiser)).send({ guestId: f.guest.id });
    expect(listed.status).toBe(201);

    // And /me reports the setting.
    const me = await request(app).get('/api/tenants/me').set(headersFor(f.organiser));
    expect(me.body.data.planSettings.qrCheckInEnabled).toBe(false);
  });
});

describe('CHECKIN_QR_SECRET at start-up', () => {
  it('refuses to start a deployed server without one, or with a short one; local development may go without', () => {
    expect(() => assertCheckInQrSecretConfigured({ NODE_ENV: 'production', STORAGE_ENV: 'prod' })).toThrow(/CHECKIN_QR_SECRET is not set/);
    expect(() => assertCheckInQrSecretConfigured({ NODE_ENV: 'production' })).toThrow(/CHECKIN_QR_SECRET is not set/);
    expect(() => assertCheckInQrSecretConfigured({ STORAGE_ENV: 'staging' })).toThrow(/CHECKIN_QR_SECRET is not set/);
    expect(() => assertCheckInQrSecretConfigured({ NODE_ENV: 'production', CHECKIN_QR_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => assertCheckInQrSecretConfigured({ NODE_ENV: 'production', CHECKIN_QR_SECRET: randomBytes(32).toString('base64url') })).not.toThrow();
    expect(() => assertCheckInQrSecretConfigured({ NODE_ENV: 'development', STORAGE_ENV: 'dev' })).not.toThrow();

    // server.ts runs the check before it connects to the database.
    const server = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const check = server.indexOf('assertCheckInQrSecretConfigured();');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(server.indexOf('await prisma.$connect()'));
  });
});

describe('the invitation QR at the door (INVITATION_LINK)', () => {
  const INVITATION_LINK_ANSWER = {
    result: 'RED', reason: 'INVITATION_LINK',
    message: 'This is the invitation, not the check-in code. Ask the guest to open their invitation and show the check-in code, or check them in from the guest list.',
    person: null, day: null, table: null, checkedInAt: null, checkedInBy: null,
  };

  it('recognises every form of invitation link, checks nobody in, names nobody, and answers identically whatever the token', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
    const f = await setup();
    await accept(f, [f.day.id], ['Sipho']);
    await prisma.invite.update({ where: { id: f.invite.id }, data: { shortCode: `Qr${randomBytes(4).toString('hex')}` } });
    const shortCode = (await prisma.invite.findUniqueOrThrow({ where: { id: f.invite.id } })).shortCode!;
    const other = await setup();
    const madeUpToken = randomBytes(32).toString('hex');

    const links = [
      // What the invitation QR holds (invite-qr.util.ts): the real guest's, another event's, a made-up one.
      buildInviteRsvpLink(f.invite.token),
      buildInviteRsvpLink(other.invite.token),
      buildInviteRsvpLink(madeUpToken),
      // A text's short link: real and made up, with and without a scheme.
      shortLinkFor(shortCode),
      shortLinkFor('Zz9Yy8Xx7W'),
      `www.e-velope.co.za/r/${shortCode}`,
      // Other ways the same link can be written.
      `https://www.e-velope.co.za/rsvp?token=${f.invite.token}`,
      `http://staging.e-velope.co.za/rsvp/?token=${madeUpToken}&utm=sms`,
      `  e-velope.co.za/rsvp?token=${f.invite.token}\n`,
    ];
    const bodies: unknown[] = [];
    for (const link of links) {
      const res = await scan(f.organiser, f.event.id, f.day.id, link);
      expect(res.status, link).toBe(200);
      expect(res.body.data, link).toEqual(INVITATION_LINK_ANSWER);
      bodies.push(res.body);
      for (const name of ['Thandi', 'Nkosi', 'Sipho']) expect(JSON.stringify(res.body)).not.toContain(name);
    }
    // Byte-for-byte the same answer for every token.
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await prisma.checkIn.count({ where: { invite: { eventId: f.event.id } } })).toBe(0);
    for (const line of logged) {
      expect(line).not.toContain(f.invite.token);
      expect(line).not.toContain(shortCode);
    }

    // Only e-velope links of those shapes: anything else is still INVALID.
    for (const notOurs of [
      `https://evil.example.com/rsvp?token=${f.invite.token}`,
      'https://www.e-velope.co.za/rsvp',
      'https://www.e-velope.co.za/r/short',
      'https://www.e-velope.co.za/events',
      f.invite.token,
    ]) {
      expect((await scan(f.organiser, f.event.id, f.day.id, notOurs)).body.data.reason, notOurs).toBe('INVALID');
    }
  });
});

describe('a replaced code (REPLACED)', () => {
  const REPLACED_ANSWER = {
    result: 'RED', reason: 'REPLACED', message: 'This code has been replaced. Ask the guest to open their invitation for the latest one.',
    person: null, day: null, table: null, checkedInAt: null, checkedInBy: null,
  };
  const REVOKED_ANSWER = { ...REPLACED_ANSWER, reason: 'REVOKED', message: 'This code is no longer valid.' };

  it("answers REPLACED for a guest's and a plus-one's code replaced by an RSVP edit, and REVOKED once they decline", async () => {
    const f = await setup();
    await accept(f, [f.day.id, f.day2.id], ['Sipho', 'Lerato']);
    const first = await activePasses(f.guest.id);
    const guestDay2 = first.find((p) => p.eventDayId === f.day2.id && p.plusOneGuestId === null)!;
    const plusOneDay1 = first.find((p) => p.eventDayId === f.day.id && p.plusOneGuestId !== null)!;

    // The same party again: every plus-one is a new row, so their codes change.
    await accept(f, [f.day.id, f.day2.id], ['Sipho', 'Lerato']);
    expect((await prisma.checkInPass.findUniqueOrThrow({ where: { id: plusOneDay1.id } })).status).toBe('REVOKED');
    const plusOne = await scan(f.organiser, f.event.id, f.day.id, payloadOf(plusOneDay1));
    expect(plusOne.body.data).toEqual(REPLACED_ANSWER);

    // The guest's own Day 2 code: dropped by one edit, back with the next.
    await accept(f, [f.day.id], ['Sipho', 'Lerato']);
    await accept(f, [f.day.id, f.day2.id], ['Sipho', 'Lerato']);
    const guest = await scan(f.organiser, f.event.id, f.day2.id, payloadOf(guestDay2));
    expect(guest.body.data).toEqual(REPLACED_ANSWER);

    // Declined: nobody is coming, so the same codes are no longer valid.
    await submit(f.invite.token, { attending: false });
    expect((await scan(f.organiser, f.event.id, f.day2.id, payloadOf(guestDay2))).body.data).toEqual(REVOKED_ANSWER);
    expect((await scan(f.organiser, f.event.id, f.day.id, payloadOf(plusOneDay1))).body.data).toEqual(REVOKED_ANSWER);
    expect(await prisma.checkIn.count({ where: { invite: { eventId: f.event.id } } })).toBe(0);
  });
});

describe('page load reads before it writes', () => {
  it('writes nothing on an unchanged second load, and still reconciles a changed RSVP on the next one', async () => {
    const f = await setup();
    // Accepted the old way, for Day 1 only.
    await prisma.invite.update({ where: { id: f.invite.id }, data: { status: 'ACCEPTED', used: true, usedAt: new Date() } });
    await prisma.attendance.create({ data: { inviteId: f.invite.id, eventDayId: f.day.id } });

    const lock = vi.spyOn(checkInPassRepository, 'lockParty');
    const revoke = vi.spyOn(checkInPassRepository, 'revoke');
    const create = vi.spyOn(checkInPassRepository, 'createMissing');
    const writes = () => lock.mock.calls.length + revoke.mock.calls.length + create.mock.calls.length;

    // First load: issues lazily, under the lock.
    expect((await passesFor(f.invite.token)).body.data.passes).toHaveLength(1);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);

    // Second load, nothing changed: no lock, no transaction, no write.
    const before = writes();
    const second = await passesFor(f.invite.token);
    expect(second.body.data.passes).toHaveLength(1);
    expect(writes()).toBe(before);

    // The RSVP changes without a submit (an organiser's edit, say): the next load reconciles.
    await prisma.attendance.create({ data: { inviteId: f.invite.id, eventDayId: f.day2.id } });
    const third = await passesFor(f.invite.token);
    expect(third.body.data.passes.map((p: { day: { label: string } }) => p.day.label)).toEqual(['Day 1', 'Day 2']);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(await activePasses(f.guest.id)).toHaveLength(2);
  });
});
