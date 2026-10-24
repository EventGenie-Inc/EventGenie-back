import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { assertRsvpDeadlineNotPassed } from '../../src/modules/invite/invite-reminder.util.js';
import { createTestGuestWithInvite } from '../helpers/fixtures.js';
import {
  createTenant,
  createActor,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  "RSVP BY <DATE>" — same-day deadlines, and the end of that day
//
//  A real organiser set up tomorrow's lunch (one day, ending 14:00) with
//  replies by the day of the lunch. The deadline (sent as the end of that
//  day) was refused as "after the event's last day", because it was
//  compared with the day's end TIME. Any day up to and including the last
//  day is allowed, on every path. And a date-only deadline means the end of
//  that day everywhere it is compared: RSVP submit, the guest page's flag,
//  reminders, registration closing, and "not in the past" at creation.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let owner: Actor;

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  owner = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

beforeEach(() => installFirebaseMock());

afterAll(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
}, 60000);

// A one-day lunch on `date`, 12:00 to 14:00.
const lunch = async (date: string, event: Record<string, unknown> = {}) => {
  const { event: e, day } = await createEventWithDay(owner.tenantId!, owner.id);
  await prisma.eventDay.update({
    where: { id: day.id },
    data: { date: new Date(`${date}T00:00:00Z`), startTime: new Date(`${date}T12:00:00Z`), endTime: new Date(`${date}T14:00:00Z`) },
  });
  if (Object.keys(event).length) await prisma.event.update({ where: { id: e.id }, data: event });
  return { eventId: e.id, dayId: day.id };
};

describe('a deadline on the event’s own (last) day is allowed', () => {
  it('PUT /api/events/:id: the lunch’s own date, as the wizard sends it and date-only; the day after is still refused', async () => {
    const date = addDays(today(), 1);
    const { eventId } = await lunch(date);
    const put = (rsvpDeadline: string) => request(app).put(`/api/events/${eventId}`).set(headersFor(owner)).send({ rsvpDeadline });

    const wizard = await put(`${date}T23:59:59`);
    expect(wizard.status, JSON.stringify(wizard.body)).toBe(200);
    const bare = await put(date);
    expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    // Stored as the end of that day, not its midnight.
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).rsvpDeadline!.toISOString()).toBe(`${date}T23:59:59.999Z`);

    const after = await put(`${addDays(date, 1)}T23:59:59`);
    expect(after.status).toBe(400);
    expect(after.body.message).toBe("The RSVP deadline can't be after the event's last day.");
  }, 60000);

  it('PUT /api/events/:id/full: the same rule, judged on the days the save leaves', async () => {
    const date = addDays(today(), 1);
    const { eventId, dayId } = await lunch(date);
    const res = await request(app)
      .put(`/api/events/${eventId}/full`)
      .set(headersFor(owner))
      .send({
        event: { rsvpDeadline: `${date}T23:59:59` },
        days: [{ id: dayId, label: 'Day 1', date: `${date}T00:00:00`, startTime: `${date}T12:00:00`, endTime: `${date}T14:00:00` }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.rsvpDeadline).toBe(`${date}T23:59:59.000Z`);
  }, 60000);

  it('the wizard’s materialize (drafts): a same-day deadline creates the event', async () => {
    const date = addDays(today(), 1);
    await eventDraftRepository.upsert(owner.tenantId!, owner.id, {
      currentStep: 4,
      payload: {
        name: 'Tomorrow’s lunch',
        rsvpDeadline: `${date}T23:59:59`,
        days: [{ label: 'Lunch', date: `${date}T00:00:00`, startTime: `${date}T12:00:00`, endTime: `${date}T14:00:00`, location: 'Hall', address: '1 Road' }],
      },
    });
    const event = await eventDraftService.materialize(owner.tenantId!, owner.id);
    expect(event!.rsvpDeadline!.toISOString()).toBe(`${date}T23:59:59.000Z`);
  }, 60000);

  it('POST /api/events: a date-only deadline of today is not "in the past"', async () => {
    const res = await request(app).post('/api/events').set(headersFor(owner)).send({ name: 'Same-day create', rsvpDeadline: today() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.rsvpDeadline).toBe(`${today()}T23:59:59.999Z`);
    const yesterday = await request(app).post('/api/events').set(headersFor(owner)).send({ name: 'Past create', rsvpDeadline: addDays(today(), -1) });
    expect(yesterday.status).toBe(400);
  }, 60000);
});

// Rows written before this fix: a date-only deadline stored as its midnight.
describe('a deadline of today, stored as today’s midnight, is open until the end of today', () => {
  it('RSVP submit is accepted and the guest page says replies are open', async () => {
    const date = today();
    const { eventId, dayId } = await lunch(addDays(date, 1), { rsvpDeadline: new Date(`${date}T00:00:00Z`) });
    const { invite } = await createTestGuestWithInvite(eventId, owner.id, [dayId]);

    const page = await request(app).get(`/api/rsvp/validate/${invite.token}`);
    expect(page.status).toBe(200);
    expect(page.body.data.isRsvpDeadlinePassed).toBe(false);

    const submit = await request(app).post('/api/rsvp/submit').send({ token: invite.token, attending: false });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
  }, 60000);

  it('yesterday’s deadline is closed: the page says so and submit is 410', async () => {
    const date = addDays(today(), -1);
    const { eventId, dayId } = await lunch(addDays(today(), 1), { rsvpDeadline: new Date(`${date}T00:00:00Z`) });
    const { invite } = await createTestGuestWithInvite(eventId, owner.id, [dayId]);
    expect((await request(app).get(`/api/rsvp/validate/${invite.token}`)).body.data.isRsvpDeadlinePassed).toBe(true);
    expect((await request(app).post('/api/rsvp/submit').send({ token: invite.token, attending: false })).status).toBe(410);
  }, 60000);

  it('reminders: allowed through the end of the deadline’s day, refused after', () => {
    const midnight = new Date('2026-10-24T00:00:00Z');
    expect(() => assertRsvpDeadlineNotPassed(midnight, new Date('2026-10-24T20:00:00Z'))).not.toThrow();
    expect(() => assertRsvpDeadlineNotPassed(midnight, new Date('2026-10-25T00:00:01Z'))).toThrow(/passed on 24 October 2026/);
    // A deliberate time of day is an instant, kept as given.
    expect(() => assertRsvpDeadlineNotPassed(new Date('2026-10-24T10:00:00Z'), new Date('2026-10-24T11:00:00Z'))).toThrow();
  });
});
