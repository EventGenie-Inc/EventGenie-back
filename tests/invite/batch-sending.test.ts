import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend, mockResendBatchSend, acceptWholeBatch } from '../setup.js';
import { sendEmailBatch, RESEND_BATCH_LIMIT } from '../../src/shared/messaging/email.engine.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { sentEmails, failEmailsTo } from '../helpers/sent-emails.js';
import { inlineQrOf } from '../helpers/qr.js';
import { buildInviteRsvpLink } from '../../src/modules/invite/invite-message.util.js';
import { emailSendWorker } from '../../src/modules/email-send/email-send.worker.js';

// ─────────────────────────────────────────
//  SENDING TO MANY GUESTS
//
//  Announcements (and the cancellation email) go through Resend's batch
//  endpoint, up to 100 emails per call (email.engine.ts's sendEmailBatch):
//  a send larger than one batch reaches everyone, and a batch call that
//  fails fails only that batch's recipients. Invitations and reminders
//  carry each guest's QR code as an inline image, which the batch endpoint
//  can't take, so they are queued and the email-send worker sends them one
//  Resend call each: a refused email fails alone. Over HTTP on a 205-guest
//  event.
// ─────────────────────────────────────────

const GUESTS = 205;

let tenantId: string;
let organiser: Actor;
let eventId: string;
const guests: { guestId: string; inviteId: string; token: string; email: string }[] = [];

const email = (to: string) => ({ to, from: '"x" <x@test.invalid>', subject: 's', html: '<p>h</p>', text: 't' });

// Batch call number `n` (1-based) is refused outright; the others accept everything.
const failBatchCall = (n: number, how: 'error' | 'throw') => {
  let calls = 0;
  mockResendBatchSend.mockImplementation(async (payload: unknown[]) => {
    calls += 1;
    if (calls !== n) return acceptWholeBatch(payload);
    if (how === 'throw') throw new Error('socket hang up');
    return { data: null, error: { message: 'Too many requests', name: 'rate_limit_exceeded' } };
  });
};

const batchSizes = () => mockResendBatchSend.mock.calls.map((c) => (c[0] as unknown[]).length);
const recipientsOfCall = (n: number) => (mockResendBatchSend.mock.calls[n - 1]![0] as { to: string }[]).map((m) => m.to);

describe('sendEmailBatch', () => {
  it('sends up to 100 per call, in order, one result per email', async () => {
    const results = await sendEmailBatch(Array.from({ length: 250 }, (_, i) => email(`e${i}@test.invalid`)));
    expect(RESEND_BATCH_LIMIT).toBe(100);
    expect(batchSizes()).toEqual([100, 100, 50]);
    expect(mockResendBatchSend.mock.calls[0]![1]).toEqual({ batchValidation: 'permissive' });
    expect(recipientsOfCall(3)[49]).toBe('e249@test.invalid');
    expect(results).toHaveLength(250);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('an email Resend refuses inside a batch fails alone', async () => {
    mockResendBatchSend.mockResolvedValueOnce({
      data: { data: [{ id: 'a' }, { id: 'c' }], errors: [{ index: 1, message: 'Invalid `to` field' }] },
      error: null,
    });
    const results = await sendEmailBatch([email('a@test.invalid'), email('bad'), email('c@test.invalid')]);
    expect(results).toEqual([{ ok: true }, { ok: false, reason: 'Invalid `to` field' }, { ok: true }]);
  });

  it('a refused or thrown batch call fails exactly its own emails, and the next batch still goes', async () => {
    for (const how of ['error', 'throw'] as const) {
      mockResendBatchSend.mockClear();
      failBatchCall(2, how);
      const results = await sendEmailBatch(Array.from({ length: 250 }, (_, i) => email(`e${i}@test.invalid`)));
      expect(batchSizes()).toEqual([100, 100, 50]);
      expect(results.slice(0, 100).every((r) => r.ok)).toBe(true);
      expect(results.slice(100, 200).every((r) => !r.ok && r.reason === (how === 'throw' ? 'socket hang up' : 'Too many requests'))).toBe(true);
      expect(results.slice(200).every((r) => r.ok)).toBe(true);
    }
  });
});

describe(`a ${GUESTS}-guest event`, () => {
  beforeAll(async () => {
    tenantId = (await createTenant()).id;
    organiser = await createActor('TENANT_ADMIN', tenantId);
    const { event, day } = await createEventWithDay(tenantId, organiser.id, `Batch ${randomUUID()}`);
    eventId = event.id;
    for (let i = 0; i < GUESTS; i++) {
      guests.push({ guestId: randomUUID(), inviteId: randomUUID(), token: `batch-${randomUUID()}`, email: `batch-${i}-${randomUUID()}@test.invalid` });
    }
    await prisma.guest.createMany({ data: guests.map((g, i) => ({ id: g.guestId, eventId, firstName: `Guest${i}`, email: g.email })) });
    await prisma.invite.createMany({
      data: guests.map((g) => ({
        id: g.inviteId, eventId, guestId: g.guestId, token: g.token, status: 'PENDING' as const,
        deliveryMethod: 'EMAIL' as const, createdBy: organiser.id, updatedBy: organiser.id,
      })),
    });
    await prisma.inviteEventDay.createMany({ data: guests.map((g) => ({ inviteId: g.inviteId, eventDayId: day.id })) });
  }, 180_000);

  afterAll(async () => {
    await prisma.announcementDelivery.deleteMany({ where: { announcement: { eventId } } });
    await prisma.announcement.deleteMany({ where: { eventId } });
    await prisma.inviteReminderLog.deleteMany({ where: { eventId } });
    await deleteTenantsDeep([tenantId]);
  }, 180_000);

  beforeEach(async () => {
    installFirebaseMock();
    await prisma.invite.updateMany({ where: { eventId }, data: { deliveredAt: null, lastRemindedAt: null } });
    await prisma.inviteReminderLog.deleteMany({ where: { eventId } });
    await prisma.announcementDelivery.deleteMany({ where: { announcement: { eventId } } });
    await prisma.announcement.deleteMany({ where: { eventId } });
    // Each test sends to everyone afresh: no earlier send blocks it.
    await prisma.emailSend.deleteMany({ where: { eventId } });
  }, 60_000);

  const post = (path: string, body: object) => request(app).post(`/api/events/${eventId}${path}`).set(headersFor(organiser)).send(body);
  const allGuestIds = () => guests.map((g) => g.guestId);
  const delivered = async () =>
    new Set((await prisma.invite.findMany({ where: { eventId, deliveredAt: { not: null } }, select: { guestId: true } })).map((i) => i.guestId));

  const progress = (sendId: string) =>
    request(app).get(`/api/events/${eventId}/invites/sends/${sendId}`).set(headersFor(organiser));

  it('invitations reach every guest, one email each with their own link and QR code, and all are marked delivered', async () => {
    const res = await post('/invites/send', { guestIds: allGuestIds() });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      totalSelected: GUESTS, sendId: expect.any(String), queued: GUESTS, sent: 0, failed: 0, failures: [], skipped: 0, skippedGuests: [],
    });
    // Answered before anything went.
    expect(mockResendSend).not.toHaveBeenCalled();
    expect((await delivered()).size).toBe(0);

    expect(await emailSendWorker.runOnce({ eventId })).toEqual({ sent: GUESTS, retried: 0, failed: 0, skipped: 0 });
    expect(mockResendBatchSend).not.toHaveBeenCalled();
    expect(mockResendSend).toHaveBeenCalledTimes(GUESTS);
    expect((await progress(res.body.data.sendId)).body.data).toMatchObject({ total: GUESTS, queued: 0, sent: GUESTS, failed: 0, skipped: 0, done: true });

    const sent = sentEmails();
    expect(sent.map((e) => e.to).sort()).toEqual(guests.map((g) => g.email).sort());
    for (const g of guests) {
      const e = sent.find((m) => m.to === g.email)!;
      expect(e.html).toContain(`/rsvp?token=${g.token}`);
      expect(e.subject).toMatch(/^You've received an e-velope from /);
      expect(e.replyTo).toBe(organiser.email);
      expect(inlineQrOf(e)?.decoded).toBe(buildInviteRsvpLink(g.token));
    }
    expect((await delivered()).size).toBe(GUESTS);
  }, 120_000);

  it('invitations: an email Resend refuses fails alone and stays undelivered; the rest go', async () => {
    const refused = guests.slice(100, 107);
    failEmailsTo(refused.map((g) => g.email), 'Invalid `to` field');
    const res = await post('/invites/send', { guestIds: allGuestIds() });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalSelected: GUESTS, queued: GUESTS });
    expect(await emailSendWorker.runOnce({ eventId })).toEqual({ sent: GUESTS - refused.length, retried: 0, failed: refused.length, skipped: 0 });
    const report = (await progress(res.body.data.sendId)).body.data;
    expect(report).toMatchObject({ total: GUESTS, sent: GUESTS - refused.length, failed: refused.length, done: true });
    const failedIds = new Set(refused.map((g) => g.guestId));
    expect(new Set(report.failures.map((f: { guestId: string }) => f.guestId))).toEqual(failedIds);
    expect(report.failures[0]).toMatchObject({ reason: 'Invalid `to` field' });

    const deliveredNow = await delivered();
    expect(deliveredNow.size).toBe(GUESTS - refused.length);
    for (const id of failedIds) expect(deliveredNow.has(id)).toBe(false);
  }, 120_000);

  it('reminders: everyone, one email each; a refused email keeps its guest remindable and logs the failure', async () => {
    await prisma.invite.updateMany({ where: { eventId }, data: { deliveredAt: new Date() } });
    const failedEmails = guests.slice(200).map((g) => g.email);
    failEmailsTo(failedEmails, 'socket hang up');
    const res = await post('/invites/remind', {});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalSelected: GUESTS, queued: GUESTS, sent: 0, failed: 0, skipped: 0 });
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(await emailSendWorker.runOnce({ eventId })).toEqual({ sent: 200, retried: 0, failed: 5, skipped: 0 });
    expect(mockResendBatchSend).not.toHaveBeenCalled();
    expect(mockResendSend).toHaveBeenCalledTimes(GUESTS);

    const invites = await prisma.invite.findMany({ where: { eventId }, include: { guest: { select: { email: true } } } });
    for (const invite of invites) {
      // Cooldown started only for those who got it.
      expect(invite.lastRemindedAt === null).toBe(failedEmails.includes(invite.guest.email!));
    }
    const logs = await prisma.inviteReminderLog.findMany({ where: { eventId } });
    expect(logs).toHaveLength(GUESTS);
    expect(logs.filter((l) => !l.succeeded)).toHaveLength(5);
    expect(logs.filter((l) => !l.succeeded).every((l) => l.failureReason === 'socket hang up')).toBe(true);
  }, 120_000);

  it('an announcement reaches everyone across batches; a failed batch is recorded as those guests failing', async () => {
    await prisma.invite.updateMany({ where: { eventId }, data: { deliveredAt: new Date() } });
    failBatchCall(1, 'error');
    const res = await post('/announcements', { subject: 'Buses', body: 'Buses leave at 18:00', audience: 'EVERYONE' });
    expect(res.status).toBe(201);
    expect(batchSizes()).toEqual([100, 100, 5]);
    expect(res.body.data).toMatchObject({ sent: GUESTS - 100, failed: 100 });
    expect(res.body.data.announcement).toMatchObject({ recipientCount: GUESTS, failureCount: 100 });

    const failedEmails = new Set(recipientsOfCall(1));
    const deliveries = await prisma.announcementDelivery.findMany({
      where: { announcementId: res.body.data.announcement.id },
      include: { guest: { select: { email: true } } },
    });
    expect(deliveries).toHaveLength(GUESTS);
    for (const d of deliveries) expect(d.succeeded).toBe(!failedEmails.has(d.guest.email!));
  }, 120_000);
});
