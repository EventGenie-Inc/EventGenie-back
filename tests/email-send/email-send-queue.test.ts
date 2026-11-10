import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend } from '../setup.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { emailSendWorker, startEmailSendWorker, EMAIL_SEND_LEASE_MS, EMAIL_SEND_MAX_ATTEMPTS, SKIP_REASONS } from '../../src/modules/email-send/email-send.worker.js';
import { emailSendRepository } from '../../src/modules/email-send/email-send.repository.js';
import { sendEmailAttempt } from '../../src/shared/messaging/email.engine.js';
import { inviteEmailRendering } from '../../src/modules/invite/invite-dispatch.service.js';

// ─────────────────────────────────────────
//  INVITATIONS AND REMINDERS, SENT IN THE BACKGROUND
//
//  Send, Resend and Remind queue their emails (EmailSend, EmailSendItem)
//  and answer at once with the send's id; the email-send worker sends them,
//  paced, retrying what can be retried; GET .../invites/sends/:sendId says
//  how far it got. Never the same email twice: not on a second press, not
//  on a retried request, not after a crash or a restart.
//
//  Resend is mocked the way it behaves: an idempotency key it has seen
//  returns the first answer and sends nothing, so `deliveries` is every
//  email that really went.
// ─────────────────────────────────────────

let tenantId: string;
let organiser: Actor;
let outsider: Actor;
let eventId: string;
let dayId: string;

interface G { guestId: string; inviteId: string; email: string }

const deliveries: string[] = [];
const seenKeys = new Map<string, string>();
// Per address: a list of responses to give, in turn, before accepting.
let scripted = new Map<string, unknown[]>();

const resendLikeMock = () =>
  mockResendSend.mockImplementation(async (payload: { to: string }, options?: { idempotencyKey?: string }) => {
    const key = options?.idempotencyKey;
    if (key && seenKeys.has(key)) return { data: { id: seenKeys.get(key) }, error: null };
    const queue = scripted.get(payload.to);
    if (queue?.length) return queue.shift();
    const id = randomUUID();
    if (key) seenKeys.set(key, id);
    deliveries.push(payload.to);
    return { data: { id }, error: null };
  });

const rateLimited = { data: null, error: { message: 'Too many requests', name: 'rate_limit_exceeded', statusCode: 429 } };
const refused = { data: null, error: { message: 'Invalid `to` field', name: 'validation_error', statusCode: 422 } };

const addGuests = async (n: number, opts: { delivered?: boolean } = {}): Promise<G[]> => {
  const guests = Array.from({ length: n }, () => ({ guestId: randomUUID(), inviteId: randomUUID(), email: `q-${randomUUID()}@test.invalid` }));
  await prisma.guest.createMany({ data: guests.map((g, i) => ({ id: g.guestId, eventId, firstName: `Guest${i}`, email: g.email })) });
  await prisma.invite.createMany({
    data: guests.map((g) => ({
      id: g.inviteId, eventId, guestId: g.guestId, token: `q-${randomUUID()}`, status: 'PENDING' as const, deliveryMethod: 'EMAIL' as const,
      deliveredAt: opts.delivered ? new Date() : null, createdBy: organiser.id, updatedBy: organiser.id,
    })),
  });
  await prisma.inviteEventDay.createMany({ data: guests.map((g) => ({ inviteId: g.inviteId, eventDayId: dayId })) });
  return guests;
};

const post = (path: string, body: object) => request(app).post(`/api/events/${eventId}/invites${path}`).set(headersFor(organiser)).send(body);
const progress = (sendId: string, actor: Actor = organiser) =>
  request(app).get(`/api/events/${eventId}/invites/sends/${sendId}`).set(headersFor(actor));
const deliveriesTo = (g: G) => deliveries.filter((to) => to === g.email).length;
const later = (ms: number) => () => new Date(Date.now() + ms);

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  organiser = await createActor('TENANT_ADMIN', tenantId);
  outsider = await createActor('TENANT_ADMIN', (await createTenant()).id);
  const { event, day } = await createEventWithDay(tenantId, organiser.id, `Queue ${randomUUID()}`);
  eventId = event.id;
  dayId = day.id;
}, 60_000);

afterAll(async () => {
  await prisma.inviteReminderLog.deleteMany({ where: { eventId } });
  await deleteTenantsDeep([tenantId, outsider.tenantId!]);
}, 60_000);

beforeEach(async () => {
  installFirebaseMock();
  deliveries.length = 0;
  seenKeys.clear();
  scripted = new Map();
  resendLikeMock();
  // Every test starts with an empty queue and no daily-limit use.
  await prisma.emailSend.deleteMany({ where: { eventId } });
  await prisma.eventEmailClaim.deleteMany({ where: { eventId } });
}, 60_000);

describe('Send answers at once; the worker sends', () => {
  it('a send of 300 returns before any email goes, then every guest gets exactly one', async () => {
    const guests = await addGuests(300);
    const res = await post('/send', { guestIds: guests.map((g) => g.guestId) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalSelected: 300, sendId: expect.any(String), queued: 300, sent: 0, failed: 0, skipped: 0 });
    // Nothing went in the request.
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(await prisma.emailSendItem.count({ where: { sendId: res.body.data.sendId, status: 'QUEUED' } })).toBe(300);
    expect(await prisma.invite.count({ where: { id: { in: guests.map((g) => g.inviteId) }, deliveredAt: { not: null } } })).toBe(0);
    expect((await progress(res.body.data.sendId)).body.data).toMatchObject({ total: 300, queued: 300, sent: 0, failed: 0, skipped: 0, done: false, finishedAt: null });

    expect(await emailSendWorker.runOnce({ eventId })).toEqual({ sent: 300, retried: 0, failed: 0, skipped: 0 });
    for (const g of guests) expect(deliveriesTo(g)).toBe(1);
    expect(await prisma.invite.count({ where: { id: { in: guests.map((g) => g.inviteId) }, deliveredAt: { not: null } } })).toBe(300);
    const done = (await progress(res.body.data.sendId)).body.data;
    expect(done).toMatchObject({ total: 300, queued: 0, sent: 300, failed: 0, skipped: 0, done: true, failures: [], skippedGuests: [] });
    expect(done.finishedAt).toEqual(expect.any(String));
  }, 120_000);
});

describe('never the same email twice', () => {
  it('Send pressed again, or the same request retried, while queued or after it went, sends nothing twice', async () => {
    const guests = await addGuests(5);
    const body = { guestIds: guests.map((g) => g.guestId) };

    const first = await post('/send', body);
    expect(first.body.data).toMatchObject({ queued: 5 });

    // Again while queued, and twice at the same moment (a double click).
    const [again, twin] = await Promise.all([post('/send', body), post('/send', body)]);
    for (const res of [again, twin]) {
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ sendId: null, queued: 0, skipped: 5 });
      expect(res.body.data.skippedGuests.every((s: { reason: string; sendId: string }) => s.reason === 'ALREADY_QUEUED' && s.sendId === first.body.data.sendId)).toBe(true);
    }
    expect(await prisma.emailSendItem.count({ where: { eventId } })).toBe(5);
    // Only the queued emails were counted against the daily limit.
    expect((await prisma.eventEmailClaim.aggregate({ where: { eventId }, _sum: { emailCount: true } }))._sum.emailCount).toBe(5);

    await emailSendWorker.runOnce({ eventId });
    for (const g of guests) expect(deliveriesTo(g)).toBe(1);

    // The browser retrying the request after the emails went.
    const retried = await post('/send', body);
    expect(retried.body.data).toMatchObject({ sendId: null, queued: 0, skipped: 5 });
    expect(retried.body.data.skippedGuests[0]).toMatchObject({ reason: 'RECENTLY_SENT', sendId: first.body.data.sendId, message: expect.stringMatching(/10 minutes/) });
    await emailSendWorker.runOnce({ eventId });
    for (const g of guests) expect(deliveriesTo(g)).toBe(1);

    // After the window, a deliberate send goes again, as it always did.
    await prisma.emailSendItem.updateMany({ where: { eventId }, data: { sentAt: new Date(Date.now() - 11 * 60 * 1000) } });
    expect((await post('/send', body)).body.data).toMatchObject({ queued: 5 });
  }, 60_000);

  it('Resend pressed twice queues one email; again just after it went, none', async () => {
    const [g] = await addGuests(1, { delivered: true });
    const [a, b] = await Promise.all([post(`/${g!.inviteId}/resend`, {}), post(`/${g!.inviteId}/resend`, {})]);
    const statuses = [a.body.data.status, b.body.data.status].sort();
    expect(statuses).toEqual(['ALREADY_QUEUED', 'QUEUED']);
    expect(a.body.data.sendId).toBe(b.body.data.sendId);
    await emailSendWorker.runOnce({ eventId });
    expect(deliveriesTo(g!)).toBe(1);

    const third = await post(`/${g!.inviteId}/resend`, {});
    expect(third.body.data).toMatchObject({ status: 'RECENTLY_SENT', reason: expect.stringMatching(/wasn't sent again/) });
    await emailSendWorker.runOnce({ eventId });
    expect(deliveriesTo(g!)).toBe(1);
  }, 60_000);

  it('Remind pressed twice reminds once: the cooldown starts when the reminder is queued', async () => {
    const guests = await addGuests(3, { delivered: true });
    const first = await post('/remind', { guestIds: guests.map((g) => g.guestId) });
    expect(first.body.data).toMatchObject({ queued: 3, skipped: 0 });
    const second = await post('/remind', { guestIds: guests.map((g) => g.guestId) });
    expect(second.status).toBe(422);
    await emailSendWorker.runOnce({ eventId });
    for (const g of guests) expect(deliveriesTo(g)).toBe(1);
    expect(await prisma.inviteReminderLog.count({ where: { inviteId: { in: guests.map((g) => g.inviteId) }, succeeded: true } })).toBe(3);
  }, 60_000);
});

describe('a crash or a restart', () => {
  it('resumes after a restart: what was queued and what was mid-send all go, each exactly once', async () => {
    const guests = await addGuests(25);
    const res = await post('/send', { guestIds: guests.map((g) => g.guestId) });
    expect(res.body.data.queued).toBe(25);

    // A worker takes 20, gets the first one's call through to Resend, and
    // dies before recording anything.
    const now = new Date();
    const taken = await emailSendRepository.claimDue(now, new Date(now.getTime() + EMAIL_SEND_LEASE_MS), 20, eventId);
    expect(taken).toHaveLength(20);
    const [first] = await emailSendRepository.findInvitesForItems([taken[0]!.inviteId]);
    const ctx = await inviteEmailRendering.buildDispatchContext(first!.event);
    const email = await inviteEmailRendering.buildEmailFor('INVITE', ctx, first!);
    expect(await sendEmailAttempt({ to: first!.guest.email!, ...email }, `email-send-item/${taken[0]!.id}`)).toMatchObject({ ok: true });
    expect(deliveries).toHaveLength(1);
    // The lease runs out while the server is down.
    await prisma.emailSendItem.updateMany({ where: { sendId: res.body.data.sendId, status: 'SENDING' }, data: { leaseUntil: new Date(now.getTime() - 1000) } });

    // The server starts again: its worker runs straight away.
    const stop = startEmailSendWorker({ eventId });
    try {
      await vi.waitFor(async () => {
        expect((await progress(res.body.data.sendId)).body.data).toMatchObject({ sent: 25, done: true });
      }, { timeout: 15_000, interval: 200 });
    } finally {
      stop();
    }
    for (const g of guests) expect(deliveriesTo(g)).toBe(1);
    // The one that had gone was asked for again, with the same key, and
    // Resend sent nothing new.
    const keys = mockResendSend.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys.filter((k) => k === `email-send-item/${taken[0]!.id}`)).toHaveLength(2);
    expect(new Set(keys).size).toBe(25);
  }, 60_000);
});

describe('retries and failures', () => {
  it('a 429 is retried later and goes; a refusal fails at once; one that never stops being limited fails after the last attempt', async () => {
    const [once, always, invalid] = await addGuests(3);
    scripted.set(once!.email, [rateLimited]);
    scripted.set(always!.email, Array.from({ length: EMAIL_SEND_MAX_ATTEMPTS }, () => rateLimited));
    scripted.set(invalid!.email, [refused]);
    const res = await post('/send', { guestIds: [once!.guestId, always!.guestId, invalid!.guestId] });

    expect(await emailSendWorker.runOnce({ eventId })).toEqual({ sent: 0, retried: 2, failed: 1, skipped: 0 });
    const waiting = await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: once!.inviteId } });
    expect(waiting).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'Too many requests' });
    expect(waiting.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // Not due yet: a run now sends nothing.
    expect(await emailSendWorker.runOnce({ eventId })).toEqual({ sent: 0, retried: 0, failed: 0, skipped: 0 });

    for (let hour = 1; hour <= EMAIL_SEND_MAX_ATTEMPTS; hour++) await emailSendWorker.runOnce({ eventId, now: later(hour * 60 * 60 * 1000) });
    expect(deliveriesTo(once!)).toBe(1);
    expect(deliveriesTo(always!)).toBe(0);
    expect(await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: always!.inviteId } })).toMatchObject({ status: 'FAILED', attempts: EMAIL_SEND_MAX_ATTEMPTS });
    expect(await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: invalid!.inviteId } })).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invalid!.inviteId } })).deliveredAt).toBeNull();

    const report = (await progress(res.body.data.sendId)).body.data;
    expect(report).toMatchObject({ total: 3, queued: 0, sent: 1, failed: 2, done: true });
    expect(report.failures).toEqual(expect.arrayContaining([
      { guestId: always!.guestId, name: expect.any(String), contact: always!.email, reason: 'Too many requests' },
      { guestId: invalid!.guestId, name: expect.any(String), contact: invalid!.email, reason: 'Invalid `to` field' },
    ]));
  }, 60_000);

  it('a reminder that fails gives its cooldown back and is logged as failed', async () => {
    const [g] = await addGuests(1, { delivered: true });
    scripted.set(g!.email, [refused]);
    await post('/remind', { guestIds: [g!.guestId] });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: g!.inviteId } })).lastRemindedAt).not.toBeNull();
    await emailSendWorker.runOnce({ eventId });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: g!.inviteId } })).lastRemindedAt).toBeNull();
    expect(await prisma.inviteReminderLog.findFirstOrThrow({ where: { inviteId: g!.inviteId } })).toMatchObject({ succeeded: false, failureReason: 'Invalid `to` field', sentBy: organiser.id });
  }, 60_000);

  it('no longer needed when its turn comes: skipped, nothing sent, the reason shown', async () => {
    const [removed, answered, fine] = await addGuests(3, { delivered: true });
    const res = await post('/remind', { guestIds: [removed!.guestId, answered!.guestId, fine!.guestId] });
    expect(res.body.data.queued).toBe(3);
    await prisma.guest.update({ where: { id: removed!.guestId }, data: { isArchived: true } });
    await prisma.invite.update({ where: { id: answered!.inviteId }, data: { status: 'ACCEPTED' } });

    expect(await emailSendWorker.runOnce({ eventId })).toEqual({ sent: 1, retried: 0, failed: 0, skipped: 2 });
    expect(deliveries).toEqual([fine!.email]);
    // The answered guest's cooldown is given back.
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: answered!.inviteId } })).lastRemindedAt).toBeNull();
    const report = (await progress(res.body.data.sendId)).body.data;
    expect(report).toMatchObject({ sent: 1, skipped: 2, failed: 0, done: true });
    expect(report.skippedGuests.map((s: { reason: string }) => s.reason).sort()).toEqual([SKIP_REASONS.GUEST_REMOVED, SKIP_REASONS.ANSWERED].sort());
  }, 60_000);
});

describe('GET /invites/sends/:sendId', () => {
  it("is the event's organisers' only: another tenant and an unknown send are 404", async () => {
    const [g] = await addGuests(1);
    const res = await post('/send', { guestIds: [g!.guestId] });
    expect((await progress(res.body.data.sendId)).status).toBe(200);
    expect((await progress(res.body.data.sendId, outsider)).status).toBe(404);
    expect((await progress('no-such-send')).status).toBe(404);
  }, 60_000);
});
