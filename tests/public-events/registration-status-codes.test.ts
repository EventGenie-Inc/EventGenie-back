import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, view, prisma } from './helpers.js';

// ─────────────────────────────────────────
//  WHY REGISTRATION IS CLOSED — registration.code
//
//  The registration state carries the exact cause as a code, alongside the
//  coarser `reason` (CANCELLED / CLOSED / FULL) the page's layout follows,
//  with guest words that say the true reason. "Not open yet" is only a
//  draft's: registration has never opened. A deadline of today (stored as
//  today's midnight, the date-only form) is open until the end of today.
// ─────────────────────────────────────────

beforeEach(() => installFirebaseMock());

afterEach(async () => {
  await cleanupPublicEventFixtures();
});

const DAY = 86_400_000;
const todayMidnight = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const registrationOf = async (shareToken: string) => (await view(shareToken)).body.data.registration;

describe('an open registration', () => {
  it('has no reason and no code', async () => {
    const ev = await createPublicEvent();
    expect(await registrationOf(ev.shareToken)).toMatchObject({ isOpen: true, reason: null, code: null, message: null });
  }, 60000);

  it('with the RSVP deadline today (date-only, stored as its midnight), is open until the end of today', async () => {
    const ev = await createPublicEvent({ event: { rsvpDeadline: todayMidnight() } });
    const reg = await registrationOf(ev.shareToken);
    expect(reg).toMatchObject({ isOpen: true, code: null });
    expect(reg.closesAt).toBe(`${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`);
    expect((await register(ev.shareToken, {})).status).toBe(201);
  }, 60000);
});

describe('the organiser’s closing date', () => {
  it('may be the RSVP deadline’s own day, in either form; the day after is refused', async () => {
    const date = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    // As the wizard stores it.
    const ev = await createPublicEvent({ event: { rsvpDeadline: new Date(`${date}T23:59:59Z`) } });
    const put = (closesAt: string) =>
      request(app).put(`/api/events/${ev.eventId}/registration-settings`).set(headersFor(ev.organiser)).send({ closesAt });

    for (const closesAt of [date, `${date}T23:59:59`]) {
      const res = await put(closesAt);
      expect(res.status, `${closesAt}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const after = await put(new Date(Date.parse(date) + DAY).toISOString().slice(0, 10));
    expect(after.status).toBe(422);
    expect(after.body.code).toBe('REGISTRATION_SETTINGS_CLOSES_AT_AFTER_DEADLINE');
  }, 60000);
});

describe('each closed state says its own reason', () => {
  it('EVENT_CANCELLED', async () => {
    const ev = await createPublicEvent({ event: { status: 'CANCELLED' } });
    expect(await registrationOf(ev.shareToken)).toMatchObject({
      isOpen: false, reason: 'CANCELLED', code: 'EVENT_CANCELLED', message: 'This event has been cancelled.',
    });
  }, 60000);

  it('EVENT_FINISHED', async () => {
    const ev = await createPublicEvent();
    await prisma.eventDay.update({ where: { id: ev.dayIds[0]! }, data: { date: new Date(Date.now() - 3 * DAY) } });
    expect(await registrationOf(ev.shareToken)).toMatchObject({
      isOpen: false, reason: 'CLOSED', code: 'EVENT_FINISHED', message: 'This event has already taken place.',
    });
  }, 60000);

  it('NOT_PUBLISHED, the only "not open yet" (the organiser’s settings show it for a draft)', async () => {
    const ev = await createPublicEvent({ event: { status: 'DRAFT' } });
    const res = await request(app).get(`/api/events/${ev.eventId}/registration-settings`).set(headersFor(ev.organiser));
    expect(res.status).toBe(200);
    expect(res.body.data.registration).toMatchObject({
      isOpen: false, reason: 'CLOSED', code: 'NOT_PUBLISHED', message: 'Registration for this event is not open yet.',
    });
  }, 60000);

  it('CLOSING_DATE_PASSED: the organiser’s own closing date', async () => {
    const closes = new Date(todayMidnight().getTime() - 2 * DAY);
    const ev = await createPublicEvent({ event: { registrationClosesAt: closes, rsvpDeadline: new Date(Date.now() + 5 * DAY) } });
    expect(await registrationOf(ev.shareToken)).toMatchObject({
      isOpen: false, reason: 'CLOSED', code: 'CLOSING_DATE_PASSED',
      message: expect.stringMatching(/^Registration for this event closed on \d+ \w+ \d{4}\.$/),
    });
  }, 60000);

  it('RSVP_DEADLINE_PASSED: no closing date of its own, and the deadline was yesterday', async () => {
    const ev = await createPublicEvent({ event: { rsvpDeadline: new Date(todayMidnight().getTime() - DAY) } });
    const reg = await registrationOf(ev.shareToken);
    expect(reg).toMatchObject({
      isOpen: false, reason: 'CLOSED', code: 'RSVP_DEADLINE_PASSED',
      message: expect.stringMatching(/^Replies for this event closed on \d+ \w+ \d{4}, so registration is closed\.$/),
    });
    // The refusal at register says the same.
    const refused = await register(ev.shareToken, {});
    expect(refused.status).toBe(410);
    expect(refused.body.message).toBe(reg.message);
  }, 60000);

  it('NO_DAYS_OPEN', async () => {
    const ev = await createPublicEvent();
    await prisma.eventDay.update({ where: { id: ev.dayIds[0]! }, data: { openForRegistration: false } });
    expect(await registrationOf(ev.shareToken)).toMatchObject({
      isOpen: false, reason: 'CLOSED', code: 'NO_DAYS_OPEN', message: "Registration isn't open for any day of this event.",
    });
  }, 60000);

  it('FULL', async () => {
    const ev = await createPublicEvent({ event: { registrationCap: 1 } });
    expect((await register(ev.shareToken, {})).status).toBe(201);
    expect(await registrationOf(ev.shareToken)).toMatchObject({ isOpen: false, reason: 'FULL', code: 'FULL' });
  }, 60000);
});
