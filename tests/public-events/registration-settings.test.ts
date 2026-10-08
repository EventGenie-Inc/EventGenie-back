import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { createActor, headersFor, installFirebaseMock, assign, createEventWithDay } from '../helpers/team.js';
import { createPublicEvent, cleanupPublicEventFixtures, prisma } from './helpers.js';

// ─────────────────────────────────────────
//  REGISTRATION SETTINGS — /api/events/:eventId/registration-settings
//
//  Organiser-only, tenant-scoped, and under the assignment lock (through
//  eventService.getScopedWithPass). Domains are normalised, the cap is a
//  whole number never above the plan's guest limit, the closing date is
//  never after the RSVP deadline, and only this event's live days can be
//  opened.
// ─────────────────────────────────────────

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPublicEventFixtures();
});

const url = (eventId: string) => `/api/events/${eventId}/registration-settings`;

describe('reading and saving', () => {
  it('saves normalised domains, a cap, a closing date, the plus-one allowance and the open days', async () => {
    installFirebaseMock();
    const ev = await createPublicEvent({ days: 2, event: { rsvpDeadline: new Date('2027-02-20T23:59:59Z') } });

    const res = await request(app)
      .put(url(ev.eventId))
      .set(headersFor(ev.organiser))
      .send({
        allowedEmailDomains: ['  @Company.CO.ZA ', 'company.co.za', 'partner.co.za'],
        cap: 40,
        closesAt: '2027-02-15T17:00:00',
        plusOnesAllowed: 1,
        openDayIds: [ev.dayIds[1]],
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      allowedEmailDomains: ['company.co.za', 'partner.co.za'],
      cap: 40,
      closesAt: '2027-02-15T17:00:00.000Z',
      plusOnesAllowed: 1,
      registeredCount: 0,
      planGuestLimit: null,
      registration: { isOpen: true, closesAt: '2027-02-15T17:00:00.000Z' },
    });
    expect(res.body.data.days.map((d: { openForRegistration: boolean }) => d.openForRegistration)).toEqual([false, true]);

    // A partial save keeps the rest.
    const partial = await request(app).put(url(ev.eventId)).set(headersFor(ev.organiser)).send({ cap: null });
    expect(partial.body.data).toMatchObject({ cap: null, plusOnesAllowed: 1, allowedEmailDomains: ['company.co.za', 'partner.co.za'] });

    const read = await request(app).get(url(ev.eventId)).set(headersFor(ev.organiser));
    expect(read.status).toBe(200);
    expect(read.body.data.cap).toBeNull();
  }, 60000);

  it('refuses what the registration page could never honour', async () => {
    installFirebaseMock();
    const ev = await createPublicEvent({ event: { rsvpDeadline: new Date('2027-02-20T23:59:59Z') } });
    const other = await createPublicEvent();
    const put = (body: Record<string, unknown>) => request(app).put(url(ev.eventId)).set(headersFor(ev.organiser)).send(body);

    expect((await put({ allowedEmailDomains: ['not a domain'] })).status).toBe(422);
    expect((await put({ allowedEmailDomains: 'company.co.za' })).status).toBe(400);
    expect((await put({ cap: 0 })).status).toBe(422);
    expect((await put({ cap: 2.5 })).status).toBe(422);
    expect((await put({ plusOnesAllowed: -1 })).status).toBe(422);
    expect((await put({ closesAt: 'soon' })).status).toBe(422);
    const afterDeadline = await put({ closesAt: '2027-02-21T09:00:00' });
    expect(afterDeadline.status).toBe(422);
    expect(afterDeadline.body.message).toMatch(/can't close after the RSVP deadline \(20 February 2027\)/);
    expect((await put({ openDayIds: [] })).status).toBe(422);
    // Another event's day (another tenant's here) is not part of this event.
    expect((await put({ openDayIds: [other.dayIds[0]] })).status).toBe(422);

    const unchanged = await prisma.event.findUniqueOrThrow({ where: { id: ev.eventId } });
    expect(unchanged).toMatchObject({ registrationEmailDomains: [], registrationCap: null, registrationClosesAt: null, registrationPlusOnesAllowed: 0 });
  }, 60000);

  it('the cap can never be above the plan’s guest limit', async () => {
    installFirebaseMock();
    const before = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'CELEBRATE' } });
    await prisma.subscriptionTierConfig.upsert({
      where: { tier: 'CELEBRATE' },
      create: { tier: 'CELEBRATE', maxGuestsPerEvent: 100 },
      update: { maxGuestsPerEvent: 100 },
    });
    try {
      const ev = await createPublicEvent();
      await prisma.tenant.update({ where: { id: ev.tenantId }, data: { subscriptionTier: 'CELEBRATE' } });
      const put = (cap: number) => request(app).put(url(ev.eventId)).set(headersFor(ev.organiser)).send({ cap });

      const over = await put(101);
      expect(over.status).toBe(422);
      expect(over.body.message).toBe('The CELEBRATE plan allows 100 guests per event, so the registration cap can be at most 100.');
      const ok = await put(100);
      expect(ok.status).toBe(200);
      expect(ok.body.data.planGuestLimit).toBe(100);
    } finally {
      if (before) await prisma.subscriptionTierConfig.update({ where: { tier: 'CELEBRATE' }, data: { maxGuestsPerEvent: before.maxGuestsPerEvent } });
      else await prisma.subscriptionTierConfig.delete({ where: { tier: 'CELEBRATE' } });
    }
  }, 60000);

  it('a cancelled event’s settings can’t be changed', async () => {
    installFirebaseMock();
    const ev = await createPublicEvent();
    await prisma.event.update({ where: { id: ev.eventId }, data: { status: 'CANCELLED' } });
    expect((await request(app).put(url(ev.eventId)).set(headersFor(ev.organiser)).send({ cap: 5 })).status).toBe(409);
  }, 60000);
});

describe('scoping', () => {
  it('another tenant’s event is a 404, read or write', async () => {
    installFirebaseMock();
    const mine = await createPublicEvent();
    const theirs = await createPublicEvent();
    expect((await request(app).get(url(theirs.eventId)).set(headersFor(mine.organiser))).status).toBe(404);
    expect((await request(app).put(url(theirs.eventId)).set(headersFor(mine.organiser)).send({ cap: 1 })).status).toBe(404);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: theirs.eventId } })).registrationCap).toBeNull();
  }, 60000);

  it('the assignment lock applies: a locked EVENT_ADMIN reaches only their assigned events', async () => {
    installFirebaseMock();
    const ev = await createPublicEvent();
    const member = await createActor('EVENT_ADMIN', ev.tenantId);
    const { event: assigned } = await createEventWithDay(ev.tenantId, ev.organiser.id);
    await assign(ev.tenantId, member.id, assigned.id, ev.organiser.id);

    expect((await request(app).get(url(ev.eventId)).set(headersFor(member))).status).toBe(404);
    expect((await request(app).put(url(ev.eventId)).set(headersFor(member)).send({ cap: 1 })).status).toBe(404);
    expect((await request(app).get(url(assigned.id)).set(headersFor(member))).status).toBe(200);
  }, 60000);

  it('with publicEvents off it is a 404', async () => {
    installFirebaseMock();
    const ev = await createPublicEvent();
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    expect((await request(app).get(url(ev.eventId)).set(headersFor(ev.organiser))).status).toBe(404);
  }, 60000);
});
