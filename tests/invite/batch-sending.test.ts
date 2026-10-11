import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend, mockResendBatchSend, acceptWholeBatch } from '../setup.js';
import { sendEmailBatch, RESEND_BATCH_LIMIT } from '../../src/shared/messaging/email.engine.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { sentEmails } from '../helpers/sent-emails.js';

// ─────────────────────────────────────────
//  BATCHED SENDING
//
//  Guest sends go through Resend's batch endpoint, up to 100 emails per
//  call (email.engine.ts's sendEmailBatch). A send larger than one batch
//  reaches everyone, each with their own link; a batch call that fails
//  fails only that batch's recipients, and the next batch still goes. Over
//  HTTP for invitations, reminders and an announcement on a 205-guest
//  event (three batches: 100, 100, 5).
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
  }, 60_000);

  const post = (path: string, body: object) => request(app).post(`/api/events/${eventId}${path}`).set(headersFor(organiser)).send(body);
  const allGuestIds = () => guests.map((g) => g.guestId);
  const delivered = async () =>
    new Set((await prisma.invite.findMany({ where: { eventId, deliveredAt: { not: null } }, select: { guestId: true } })).map((i) => i.guestId));

  it('invitations reach every guest, each with their own link, and all are marked delivered', async () => {
    const res = await post('/invites/send', { guestIds: allGuestIds() });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ totalSelected: GUESTS, sent: GUESTS, failed: 0, failures: [] });
    expect(batchSizes()).toEqual([100, 100, 5]);

    const sent = sentEmails();
    expect(sent.map((e) => e.to).sort()).toEqual(guests.map((g) => g.email).sort());
    for (const g of guests) {
      const e = sent.find((m) => m.to === g.email)!;
      expect(e.html).toContain(`/rsvp?token=${g.token}`);
      expect(e.subject).toMatch(/^You've received an e-velope from /);
      expect(e.replyTo).toBe(organiser.email);
    }
    expect((await delivered()).size).toBe(GUESTS);
  }, 120_000);

  it('invitations: a failed batch fails only its own guests, who stay undelivered; the rest go', async () => {
    failBatchCall(2, 'error');
    const res = await post('/invites/send', { guestIds: allGuestIds() });
    expect(res.status).toBe(200);
    const failedEmails = recipientsOfCall(2);
    expect(res.body.data).toMatchObject({ totalSelected: GUESTS, sent: GUESTS - 100, failed: 100 });
    const failedIds = new Set(guests.filter((g) => failedEmails.includes(g.email)).map((g) => g.guestId));
    expect(new Set(res.body.data.failures.map((f: { guestId: string }) => f.guestId))).toEqual(failedIds);
    expect(res.body.data.failures[0]).toMatchObject({ reason: 'Too many requests' });

    const deliveredNow = await delivered();
    expect(deliveredNow.size).toBe(GUESTS - 100);
    for (const id of failedIds) expect(deliveredNow.has(id)).toBe(false);
  }, 120_000);

  it('reminders: everyone across batches; a failed batch keeps its guests remindable and logs each failure', async () => {
    await prisma.invite.updateMany({ where: { eventId }, data: { deliveredAt: new Date() } });
    failBatchCall(3, 'throw');
    const res = await post('/invites/remind', {});
    expect(res.status).toBe(200);
    expect(batchSizes()).toEqual([100, 100, 5]);
    expect(res.body.data).toMatchObject({ totalSelected: GUESTS, sent: 200, failed: 5, skipped: 0 });

    const failedEmails = recipientsOfCall(3);
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
