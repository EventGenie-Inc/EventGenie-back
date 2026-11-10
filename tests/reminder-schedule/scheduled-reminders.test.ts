import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend } from '../setup.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { reminderScheduleWorker, REMINDER_SCHEDULE_LEASE_MS } from '../../src/modules/reminder-schedule/reminder-schedule.worker.js';
import { reminderScheduleRepository } from '../../src/modules/reminder-schedule/reminder-schedule.repository.js';
import { emailSendWorker } from '../../src/modules/email-send/email-send.worker.js';
import { parseSaLocal, presetSendAt, formatSaLocal } from '../../src/modules/reminder-schedule/reminder-schedule-time.util.js';
import { EVENT_EMAILS_PER_DAY } from '../../src/modules/invite/event-email-limit.util.js';

// ─────────────────────────────────────────
//  SCHEDULED REMINDERS
//
//  An organiser schedules a reminder to everyone who hasn't replied; when
//  it is due the reminder-schedule worker hands it to the email queue as a
//  REMINDER send, exactly once, and the email-send worker sends it. Resend
//  is mocked the way it behaves (an idempotency key it has seen sends
//  nothing new), so `deliveries` is every email that really went.
// ─────────────────────────────────────────

let tenantId: string;
let organiser: Actor;
let outsider: Actor;
let eventId: string;
let dayId: string;
const eventIds: string[] = [];

interface G { guestId: string; inviteId: string; email: string }

const deliveries: string[] = [];
const seenKeys = new Map<string, string>();

const resendLikeMock = () =>
  mockResendSend.mockImplementation(async (payload: { to: string }, options?: { idempotencyKey?: string }) => {
    const key = options?.idempotencyKey;
    if (key && seenKeys.has(key)) return { data: { id: seenKeys.get(key) }, error: null };
    const id = randomUUID();
    if (key) seenKeys.set(key, id);
    deliveries.push(payload.to);
    return { data: { id }, error: null };
  });

// Guests whose invitation was delivered and who haven't replied, unless
// `opts` says otherwise.
const addGuests = async (
  n: number,
  opts: {
    delivered?: boolean;
    status?: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    lastRemindedAt?: Date | null;
    guest?: { pendingApproval?: boolean; registrationDeclinedAt?: Date; isArchived?: boolean };
    inviteArchived?: boolean;
    sms?: boolean;
  } = {}
): Promise<G[]> => {
  const guests = Array.from({ length: n }, () => ({ guestId: randomUUID(), inviteId: randomUUID(), email: `sr-${randomUUID()}@test.invalid` }));
  await prisma.guest.createMany({
    data: guests.map((g, i) => ({
      id: g.guestId, eventId, firstName: `Guest${i}`,
      ...(opts.sms ? { phoneNumber: `+2782${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` } : { email: g.email }),
      ...opts.guest,
    })),
  });
  await prisma.invite.createMany({
    data: guests.map((g) => ({
      id: g.inviteId, eventId, guestId: g.guestId, token: `sr-${randomUUID()}`,
      status: opts.status ?? 'PENDING', deliveryMethod: opts.sms ? 'SMS' as const : 'EMAIL' as const,
      deliveredAt: opts.delivered === false ? null : new Date(Date.now() - 3 * 24 * 3600_000),
      lastRemindedAt: opts.lastRemindedAt ?? null,
      isArchived: opts.inviteArchived ?? false,
      createdBy: organiser.id, updatedBy: organiser.id,
    })),
  });
  await prisma.inviteEventDay.createMany({ data: guests.map((g) => ({ inviteId: g.inviteId, eventDayId: dayId })) });
  return guests;
};

const api = () => `/api/events/${eventId}/reminder-schedules`;
const schedule = (body: object, actor: Actor = organiser) => request(app).post(api()).set(headersFor(actor)).send(body);
const list = (actor: Actor = organiser) => request(app).get(api()).set(headersFor(actor));
const cancel = (id: string, actor: Actor = organiser) => request(app).post(`${api()}/${id}/cancel`).set(headersFor(actor)).send({});

// Schedules one through the route, then makes it due now (the route
// refuses a time in the past, rightly).
const scheduleDueNow = async (): Promise<string> => {
  const res = await schedule({ preset: 'IN_1_DAY' });
  expect(res.status).toBe(201);
  await prisma.reminderSchedule.update({ where: { id: res.body.data.id }, data: { sendAt: new Date(Date.now() - 1000) } });
  return res.body.data.id;
};

const runScheduler = (options: { now?: () => Date } = {}) => reminderScheduleWorker.runOnce({ eventId, ...options });
const runEmails = () => emailSendWorker.runOnce({ eventId });
const row = (id: string) => prisma.reminderSchedule.findUniqueOrThrow({ where: { id } });
const reminderSends = () => prisma.emailSend.findMany({ where: { eventId, kind: 'REMINDER' }, include: { items: true } });
const deliveriesTo = (g: G) => deliveries.filter((to) => to === g.email).length;

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  organiser = await createActor('TENANT_ADMIN', tenantId);
  outsider = await createActor('TENANT_ADMIN', (await createTenant()).id);
}, 60_000);

afterAll(async () => {
  await prisma.inviteReminderLog.deleteMany({ where: { eventId: { in: eventIds } } });
  await deleteTenantsDeep([tenantId, outsider.tenantId!]);
}, 60_000);

// A fresh event for every test: the schedules and guests are its own.
beforeEach(async () => {
  installFirebaseMock();
  vi.unstubAllEnvs();
  deliveries.length = 0;
  seenKeys.clear();
  resendLikeMock();
  const { event, day } = await createEventWithDay(tenantId, organiser.id, `Scheduled ${randomUUID()}`);
  eventId = event.id;
  dayId = day.id;
  eventIds.push(eventId);
}, 60_000);

describe('scheduling', () => {
  it('in 1 day, 1 week, 1 month, or a custom South African time stored in UTC', async () => {
    const before = new Date();
    const day = await schedule({ preset: 'IN_1_DAY' });
    expect(day.status).toBe(201);
    const after = new Date();
    const at = new Date(day.body.data.sendAt).getTime();
    // To the minute, a day on.
    expect(at).toBeGreaterThanOrEqual(presetSendAt('IN_1_DAY', before).getTime());
    expect(at).toBeLessThanOrEqual(presetSendAt('IN_1_DAY', after).getTime());
    expect(day.body.data).toMatchObject({ status: 'SCHEDULED', preset: 'IN_1_DAY', sendId: null, queued: null, delivery: null, skipReason: null });

    expect((await schedule({ preset: 'IN_1_WEEK' })).status).toBe(201);
    expect((await schedule({ preset: 'IN_1_MONTH' })).status).toBe(201);

    // 09:00 in South Africa is 07:00 UTC, and reads back as 09:00.
    const custom = await schedule({ preset: 'CUSTOM', sendAt: '2027-01-10T09:00' });
    expect(custom.status).toBe(201);
    expect(custom.body.data).toMatchObject({ preset: 'CUSTOM', sendAt: '2027-01-10T07:00:00.000Z', sendAtLocal: '2027-01-10T09:00' });
    expect((await row(custom.body.data.id)).sendAt.toISOString()).toBe('2027-01-10T07:00:00.000Z');
  });

  it('a month is a calendar month in South Africa, kept to the last day of a shorter one', () => {
    // 31 January 10:00 SAST -> 28 February 10:00 SAST.
    expect(formatSaLocal(presetSendAt('IN_1_MONTH', parseSaLocal('2027-01-31T10:00')!))).toBe('2027-02-28T10:00');
    // 23:30 SAST on 30 November is 21:30 UTC: still November in South Africa.
    expect(formatSaLocal(presetSendAt('IN_1_MONTH', parseSaLocal('2026-11-30T23:30')!))).toBe('2026-12-30T23:30');
    expect(formatSaLocal(presetSendAt('IN_1_WEEK', parseSaLocal('2026-12-28T08:15')!))).toBe('2027-01-04T08:15');
  });

  it('refuses a malformed request with 400, and a time in the past with its own code', async () => {
    for (const body of [{}, { preset: 'TOMORROW' }, { preset: 'CUSTOM' }, { preset: 'CUSTOM', sendAt: '2027-02-30T09:00' },
      { preset: 'CUSTOM', sendAt: '10 January 2027' }, { preset: 'IN_1_DAY', sendAt: '2027-01-10T09:00' }]) {
      const res = await schedule(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('REMINDER_SCHEDULE_INVALID');
    }
    const past = await schedule({ preset: 'CUSTOM', sendAt: formatSaLocal(new Date(Date.now() - 60_000)) });
    expect(past.status).toBe(422);
    expect(past.body.code).toBe('REMINDER_TIME_IN_PAST');
    expect(await prisma.reminderSchedule.count({ where: { eventId } })).toBe(0);
  });

  it('refuses a time after the RSVP deadline (the end of its day, in South Africa)', async () => {
    // "RSVP by 15 January 2027", as the wizard stores it.
    await prisma.event.update({ where: { id: eventId }, data: { rsvpDeadline: new Date('2027-01-15T23:59:59Z') } });
    const lateEvening = await schedule({ preset: 'CUSTOM', sendAt: '2027-01-15T23:00' });
    expect(lateEvening.status).toBe(201);
    // 00:30 on the 16th in South Africa (22:30 UTC on the 15th): replies
    // have closed for the organiser, so it's refused.
    const after = await schedule({ preset: 'CUSTOM', sendAt: '2027-01-16T00:30' });
    expect(after.status).toBe(422);
    expect(after.body.code).toBe('REMINDER_AFTER_RSVP_DEADLINE');
    expect(after.body.message).toContain('Replies close at the end of');
    expect(await prisma.reminderSchedule.count({ where: { eventId } })).toBe(1);
  });

  it('refuses a time after the event has started', async () => {
    // The fixture's day is 1 March 2027; give it a 18:00 start.
    await prisma.eventDay.update({ where: { id: dayId }, data: { startTime: new Date('2027-03-01T18:00:00Z') } });
    expect((await schedule({ preset: 'CUSTOM', sendAt: '2027-03-01T17:00' })).status).toBe(201);
    const after = await schedule({ preset: 'CUSTOM', sendAt: '2027-03-01T18:30' });
    expect(after.status).toBe(422);
    expect(after.body.code).toBe('REMINDER_AFTER_EVENT_START');
  });

  it('refuses for an event a manual reminder is refused for: a draft, a public event, replies closed', async () => {
    await prisma.event.update({ where: { id: eventId }, data: { status: 'DRAFT' } });
    expect((await schedule({ preset: 'IN_1_DAY' })).status).toBe(409);
    await prisma.event.update({ where: { id: eventId }, data: { status: 'PUBLISHED', visibility: 'PUBLIC' } });
    expect((await schedule({ preset: 'IN_1_DAY' })).status).toBe(400);
    await prisma.event.update({ where: { id: eventId }, data: { visibility: 'PRIVATE', rsvpDeadline: new Date('2026-01-01T23:59:59Z') } });
    expect((await schedule({ preset: 'IN_1_DAY' })).status).toBe(409);
    expect(await prisma.reminderSchedule.count({ where: { eventId } })).toBe(0);
  });

  it('at most 5 not yet sent per event; cancelling one makes room', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await schedule({ preset: 'CUSTOM', sendAt: `2027-01-1${i}T09:00` })).body.data.id);
    const sixth = await schedule({ preset: 'IN_1_DAY' });
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('REMINDER_SCHEDULE_LIMIT');
    expect((await list()).body.data).toMatchObject({ maxScheduled: 5, remaining: 0 });

    expect((await cancel(ids[0]!)).status).toBe(200);
    expect((await schedule({ preset: 'IN_1_DAY' })).status).toBe(201);
  });

  it('eight at once still stops at 5', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => schedule({ preset: 'CUSTOM', sendAt: `2027-01-1${i}T09:00` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await prisma.reminderSchedule.count({ where: { eventId } })).toBe(5);
  });

  it("another tenant's event is a 404, on every route", async () => {
    const mine = (await schedule({ preset: 'IN_1_DAY' })).body.data.id;
    expect((await list(outsider)).status).toBe(404);
    expect((await schedule({ preset: 'IN_1_DAY' }, outsider)).status).toBe(404);
    expect((await cancel(mine, outsider)).status).toBe(404);
    expect((await row(mine)).status).toBe('SCHEDULED');
  });
});

describe('sending', () => {
  it('a schedule due now is queued once, even with two workers, and each guest gets one reminder', async () => {
    const waiting = await addGuests(3);
    const id = await scheduleDueNow();

    const [a, b] = await Promise.all([runScheduler(), runScheduler()]);
    expect(a.sent + b.sent).toBe(1);
    // The other worker never took it at all: the claim is what keeps it to
    // one, not the cooldown or the queue's duplicate check behind it.
    expect(a.notFinished + b.notFinished + a.skipped + b.skipped).toBe(0);
    expect((await row(id)).attempts).toBe(1);
    // And again later: nothing more.
    expect((await runScheduler()).sent).toBe(0);

    const sends = await reminderSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.items.map((i) => i.inviteId).sort()).toEqual(waiting.map((g) => g.inviteId).sort());
    expect(sends[0]!.createdBy).toBe(organiser.id);
    expect(await row(id)).toMatchObject({ status: 'SENT', emailSendId: sends[0]!.id, queuedCount: 3, skippedRecentlyReminded: 0, skippedOther: 0 });

    // The email queue sends it like any reminder, with the QR code.
    expect(await runEmails()).toMatchObject({ sent: 3, failed: 0, skipped: 0 });
    for (const g of waiting) expect(deliveriesTo(g)).toBe(1);
    const sentEmail = mockResendSend.mock.calls[0]![0] as { subject: string; attachments?: { contentId: string }[] };
    expect(sentEmail.subject).toContain('is waiting');
    expect(sentEmail.attachments?.[0]?.contentId).toBe('invite-qr');
    expect(await prisma.inviteReminderLog.count({ where: { eventId, succeeded: true, sentBy: organiser.id } })).toBe(3);

    const listed = (await list()).body.data;
    expect(listed.counts).toEqual({ scheduled: 0, sending: 0, sent: 1, skipped: 0, cancelled: 0 });
    expect(listed.schedules[0]).toMatchObject({ status: 'SENT', sendId: sends[0]!.id, queued: 3, delivery: { queued: 0, sent: 3, failed: 0, skipped: 0 } });
  }, 60_000);

  it('a schedule a worker died holding is taken again after its lease, and queued once', async () => {
    const waiting = await addGuests(2);
    const id = await scheduleDueNow();
    // A worker claimed it and died before queueing anything.
    const [claimed] = await reminderScheduleRepository.claimDue(new Date(), new Date(Date.now() + REMINDER_SCHEDULE_LEASE_MS), 10, eventId);
    expect(claimed!.id).toBe(id);
    // Within the lease nobody else takes it.
    expect(await runScheduler()).toEqual({ sent: 0, skipped: 0, notFinished: 0 });
    // After it, the next worker does.
    const later = () => new Date(Date.now() + REMINDER_SCHEDULE_LEASE_MS + 1000);
    expect((await runScheduler({ now: later })).sent).toBe(1);
    expect((await runScheduler({ now: later })).sent).toBe(0);
    expect(await reminderSends()).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: 'SENT', queuedCount: 2, attempts: 2 });
    await runEmails();
    for (const g of waiting) expect(deliveriesTo(g)).toBe(1);
  });

  it('only guests still without a reply when it goes: never one who replied before it was due', async () => {
    const [replies, stays] = await addGuests(2);
    const id = await scheduleDueNow();
    // They reply after it was scheduled, before it is due.
    await prisma.invite.update({ where: { id: replies!.inviteId }, data: { status: 'ACCEPTED' } });

    expect((await runScheduler()).sent).toBe(1);
    const [send] = await reminderSends();
    expect(send!.items.map((i) => i.inviteId)).toEqual([stays!.inviteId]);
    await runEmails();
    expect(deliveriesTo(replies!)).toBe(0);
    expect(deliveriesTo(stays!)).toBe(1);
    expect(await row(id)).toMatchObject({ queuedCount: 1 });
  });

  it('never pending-approval, declined, removed or archived guests or invites, plus-ones, or guests never sent an invitation', async () => {
    const waiting = await addGuests(1);
    const leftOut = [
      ...(await addGuests(1, { status: 'DECLINED' })),
      ...(await addGuests(1, { status: 'ACCEPTED' })),
      ...(await addGuests(1, { delivered: false })),
      ...(await addGuests(1, { guest: { pendingApproval: true } })),
      ...(await addGuests(1, { guest: { registrationDeclinedAt: new Date() } })),
      ...(await addGuests(1, { guest: { isArchived: true } })),
      ...(await addGuests(1, { inviteArchived: true })),
    ];
    const plusOne = (await addGuests(1))[0]!;
    await prisma.guest.update({ where: { id: plusOne.guestId }, data: { hostGuestId: waiting[0]!.guestId } });
    leftOut.push(plusOne);

    await scheduleDueNow();
    await runScheduler();
    const [send] = await reminderSends();
    expect(send!.items.map((i) => i.inviteId)).toEqual([waiting[0]!.inviteId]);
    await runEmails();
    for (const g of leftOut) expect(deliveriesTo(g)).toBe(0);
  });

  it('the 24-hour cooldown holds, and the skipped are counted', async () => {
    const fresh = await addGuests(2);
    const recent = await addGuests(3, { lastRemindedAt: new Date(Date.now() - 2 * 3600_000) });
    const longAgo = await addGuests(1, { lastRemindedAt: new Date(Date.now() - 30 * 3600_000) });
    const id = await scheduleDueNow();

    await runScheduler();
    const [send] = await reminderSends();
    expect(send!.items.map((i) => i.inviteId).sort()).toEqual([...fresh, ...longAgo].map((g) => g.inviteId).sort());
    expect(await row(id)).toMatchObject({ status: 'SENT', queuedCount: 3, skippedRecentlyReminded: 3 });
    expect((await list()).body.data.schedules[0]).toMatchObject({ queued: 3, skippedRecentlyReminded: 3 });
    await runEmails();
    for (const g of recent) expect(deliveriesTo(g)).toBe(0);

    // The cooldown it claimed holds against a manual reminder straight after.
    const manual = await request(app).post(`/api/events/${eventId}/invites/remind`).set(headersFor(organiser)).send({});
    expect(manual.status).toBe(422);
  });

  it('everyone in the cooldown: skipped, with the reason and the count', async () => {
    await addGuests(2, { lastRemindedAt: new Date(Date.now() - 3600_000) });
    const id = await scheduleDueNow();
    expect(await runScheduler()).toMatchObject({ sent: 0, skipped: 1 });
    expect(await row(id)).toMatchObject({ status: 'SKIPPED', skipReason: 'NONE_ELIGIBLE', skippedRecentlyReminded: 2, emailSendId: null });
    expect(await reminderSends()).toHaveLength(0);
  });

  it('cancelling stops it', async () => {
    const waiting = await addGuests(2);
    const id = await scheduleDueNow();
    const res = await cancel(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, status: 'CANCELLED', cancelledAt: expect.any(String) });
    // Twice is fine.
    expect((await cancel(id)).body.data.status).toBe('CANCELLED');

    expect(await runScheduler()).toEqual({ sent: 0, skipped: 0, notFinished: 0 });
    await runEmails();
    expect(await reminderSends()).toHaveLength(0);
    for (const g of waiting) expect(deliveriesTo(g)).toBe(0);
    expect((await row(id)).status).toBe('CANCELLED');
    expect((await list()).body.data.counts).toMatchObject({ cancelled: 1, scheduled: 0 });
  });

  it("one that has gone can't be cancelled", async () => {
    await addGuests(1);
    const id = await scheduleDueNow();
    await runScheduler();
    const res = await cancel(id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REMINDER_SCHEDULE_NOT_CANCELLABLE');
    expect((await row(id)).status).toBe('SENT');
    expect((await cancel('no-such-schedule')).status).toBe(404);
  });

  it.each([
    ['a cancelled event', { status: 'CANCELLED' as const }, 'EVENT_CANCELLED'],
    ['an archived event', { isArchived: true, archivedAt: new Date() }, 'EVENT_ARCHIVED'],
    ['an event made public', { visibility: 'PUBLIC' as const }, 'EVENT_NOT_OPEN'],
  ])('%s skips it, with the reason', async (_label, change, reason) => {
    const waiting = await addGuests(2);
    const id = await scheduleDueNow();
    await prisma.event.update({ where: { id: eventId }, data: change });

    expect(await runScheduler()).toMatchObject({ sent: 0, skipped: 1 });
    expect(await row(id)).toMatchObject({ status: 'SKIPPED', skipReason: reason, skipMessage: expect.stringMatching(/^Not sent: /), emailSendId: null });
    expect(await reminderSends()).toHaveLength(0);
    await runEmails();
    for (const g of waiting) expect(deliveriesTo(g)).toBe(0);
    expect(await prisma.invite.count({ where: { eventId, lastRemindedAt: { not: null } } })).toBe(0);
  });

  it('skipped when due after the RSVP deadline, after the event started, or after it finished', async () => {
    await addGuests(1);
    await prisma.event.update({ where: { id: eventId }, data: { rsvpDeadline: new Date('2027-01-15T23:59:59Z') } });
    await prisma.eventDay.update({ where: { id: dayId }, data: { startTime: new Date('2027-03-01T18:00:00Z'), endTime: new Date('2027-03-01T23:00:00Z') } });
    const cases: [string, string][] = [
      ['2027-01-16T00:30', 'RSVP_DEADLINE_PASSED'],
      ['2027-03-01T18:30', 'EVENT_STARTED'],
      ['2027-03-02T09:00', 'EVENT_FINISHED'],
    ];
    for (const [saTime, reason] of cases) {
      const id = (await schedule({ preset: 'CUSTOM', sendAt: '2027-01-10T09:00' })).body.data.id;
      // Run as if it were that moment (the deadline and the day haven't
      // moved since it was scheduled; the clock has).
      const at = parseSaLocal(saTime)!;
      await prisma.reminderSchedule.update({ where: { id }, data: { sendAt: at } });
      await runScheduler({ now: () => at });
      expect(await row(id), reason).toMatchObject({ status: 'SKIPPED', skipReason: reason });
    }
    expect(await reminderSends()).toHaveLength(0);
  });

  it('nobody left without a reply: skipped', async () => {
    await addGuests(2, { status: 'ACCEPTED' });
    const id = await scheduleDueNow();
    await runScheduler();
    expect(await row(id)).toMatchObject({ status: 'SKIPPED', skipReason: 'NO_ONE_WAITING' });
  });

  it('over the daily email limit: refused whole, as a manual reminder is, and the organiser sees why', async () => {
    const waiting = await addGuests(3);
    // 1,998 of the 2,000 already used today.
    await prisma.eventEmailClaim.create({ data: { eventId, kind: 'INVITATION', emailCount: EVENT_EMAILS_PER_DAY - 2, claimedBy: organiser.id } });
    const id = await scheduleDueNow();

    expect(await runScheduler()).toMatchObject({ sent: 0, skipped: 1 });
    const skipped = await row(id);
    expect(skipped).toMatchObject({ status: 'SKIPPED', skipReason: 'EVENT_EMAIL_DAILY_LIMIT', emailSendId: null });
    // Its own words: skipped, and what to do. Not the button's "Choose fewer guests".
    expect(skipped.skipMessage).toBe(
      "Not sent: today's email limit for this event was reached (2,000 invitation and reminder emails in 24 hours), " +
        'so this reminder was skipped and nobody was emailed. You can schedule another one for tomorrow.'
    );
    expect((await list()).body.data.schedules[0]).toMatchObject({ skipReason: 'EVENT_EMAIL_DAILY_LIMIT', skipMessage: skipped.skipMessage });
    // Nothing queued, no cooldown started, nothing more counted.
    expect(await reminderSends()).toHaveLength(0);
    expect(await prisma.invite.count({ where: { id: { in: waiting.map((g) => g.inviteId) }, lastRemindedAt: { not: null } } })).toBe(0);
    expect(await prisma.eventEmailClaim.count({ where: { eventId } })).toBe(1);
    // The manual button gives the same answer.
    const manual = await request(app).post(`/api/events/${eventId}/invites/remind`).set(headersFor(organiser)).send({});
    expect(manual.status).toBe(429);
    expect(manual.body.code).toBe('EVENT_EMAIL_DAILY_LIMIT');
    // The button keeps its own wording.
    expect(manual.body.message).toBe(
      'This would send 3 emails, but only 2 more can go from this event in the next 24 hours ' +
        '(the limit is 2,000 a day), so nothing was sent. Choose fewer guests, or try again later.'
    );
  });

  it('SMS-only guests are left out (it is an email send) and counted', async () => {
    const email = await addGuests(1);
    await addGuests(2, { sms: true });
    const id = await scheduleDueNow();
    await runScheduler();
    const [send] = await reminderSends();
    expect(send!.items.map((i) => i.inviteId)).toEqual([email[0]!.inviteId]);
    expect(await row(id)).toMatchObject({ status: 'SENT', queuedCount: 1, skippedOther: 2 });
  });
});

describe('the scheduledReminders flag', () => {
  it('off: the routes are 404 and nothing is sent; back on, a due one goes', async () => {
    const waiting = await addGuests(2);
    const id = await scheduleDueNow();

    vi.stubEnv('FEATURES_DISABLED', 'scheduledReminders');
    expect((await list()).status).toBe(404);
    expect((await schedule({ preset: 'IN_1_DAY' })).status).toBe(404);
    expect((await cancel(id)).status).toBe(404);
    expect(await runScheduler()).toEqual({ sent: 0, skipped: 0, notFinished: 0 });
    await runEmails();
    expect(await reminderSends()).toHaveLength(0);
    for (const g of waiting) expect(deliveriesTo(g)).toBe(0);
    expect((await row(id)).status).toBe('SCHEDULED');

    vi.unstubAllEnvs();
    expect((await runScheduler()).sent).toBe(1);
  });

  it('is on by default', async () => {
    const res = await request(app).get('/api/config/features');
    expect(res.body.data.scheduledReminders).toBe(true);
  });
});
