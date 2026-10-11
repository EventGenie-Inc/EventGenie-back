import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend, mockResendBatchSend } from '../setup.js';
import { inviteDispatchService } from '../../src/modules/invite/invite-dispatch.service.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  HOW LONG A 300-GUEST SEND TAKES — a measurement, not a guarantee.
//  Opt-in, so the ordinary suite never waits on it:
//
//    MEASURE_SEND_TIMING=1 MEASURE_SEND_TIMING_OUT=timings.txt \
//      npx vitest run tests/perf/send-timing.test.ts
//
//  Every Resend call (single or batch) is held for SIMULATED_RESEND_MS, the
//  way a real API round trip would be. Measures the dispatch alone (no
//  database beyond the Reply-To lookup), then each send over HTTP against
//  the test database: invitations, reminders, an announcement and the
//  cancellation email. Prints the timings; asserts only that everyone was
//  reached. Each send sets up its own starting state, so one can be run on
//  its own with -t (the cancellation last: it cancels the event).
// ─────────────────────────────────────────

const GUESTS = 300;
const SIMULATED_RESEND_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tenantId: string;
let organiser: Actor;
let eventId: string;
let guestIds: string[] = [];
const timings: [string, number][] = [];

const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await fn();
  timings.push([label, Math.round(performance.now() - start)]);
  return result;
};

const emailsSent = () =>
  mockResendSend.mock.calls.length + mockResendBatchSend.mock.calls.reduce((n, call) => n + (call[0] as unknown[]).length, 0);

// Each send starts from the state it needs (invited, not yet reminded), set
// outside the timed part, so one can be measured on its own with -t.
const invitedNotReminded = () =>
  prisma.invite.updateMany({ where: { eventId }, data: { deliveredAt: new Date(), lastRemindedAt: null } });

const resetResend = () => {
  mockResendSend.mockReset();
  mockResendSend.mockImplementation(async () => {
    await sleep(SIMULATED_RESEND_MS);
    return { data: { id: 'ok' }, error: null };
  });
  mockResendBatchSend.mockReset();
  mockResendBatchSend.mockImplementation(async (payload: unknown[]) => {
    await sleep(SIMULATED_RESEND_MS);
    return { data: { data: payload.map((_, i) => ({ id: `b-${i}` })), errors: [] }, error: null };
  });
};

describe.skipIf(!process.env['MEASURE_SEND_TIMING'])(`sending to ${GUESTS} guests, ${SIMULATED_RESEND_MS} ms per Resend call`, () => {
  beforeAll(async () => {
    const tenant = await createTenant();
    tenantId = tenant.id;
    organiser = await createActor('TENANT_ADMIN', tenantId);
    const { event, day } = await createEventWithDay(tenantId, organiser.id, `Timing ${randomUUID()}`);
    eventId = event.id;
    guestIds = Array.from({ length: GUESTS }, () => randomUUID());
    const inviteIds = guestIds.map(() => randomUUID());
    await prisma.guest.createMany({
      data: guestIds.map((id, i) => ({ id, eventId, firstName: `Guest${i}`, email: `timing-${i}-${randomUUID()}@test.invalid` })),
    });
    await prisma.invite.createMany({
      data: guestIds.map((guestId, i) => ({
        id: inviteIds[i]!, eventId, guestId, token: `timing-${randomUUID()}`, status: 'PENDING' as const,
        deliveryMethod: 'EMAIL' as const, createdBy: organiser.id, updatedBy: organiser.id,
      })),
    });
    await prisma.inviteEventDay.createMany({ data: inviteIds.map((inviteId) => ({ inviteId, eventDayId: day.id })) });
  }, 300_000);

  afterAll(async () => {
    // Vitest swallows a passing test's console output, so the timings also
    // go to the file MEASURE_SEND_TIMING_OUT names, when set.
    const report = [
      `TIMINGS (${GUESTS} recipients, ${SIMULATED_RESEND_MS} ms per Resend call):`,
      ...timings.map(([label, ms]) => `  ${label.padEnd(34)} ${(ms / 1000).toFixed(1)} s`),
    ].join('\n');
    console.log(`\n${report}`);
    const out = process.env['MEASURE_SEND_TIMING_OUT'];
    if (out) writeFileSync(out, `${report}\n`);
    await prisma.announcementDelivery.deleteMany({ where: { announcement: { eventId } } });
    await prisma.announcement.deleteMany({ where: { eventId } });
    await prisma.inviteReminderLog.deleteMany({ where: { eventId } });
    await deleteTenantsDeep([tenantId]);
  }, 300_000);

  it('dispatch alone (announcement/cancellation path)', async () => {
    resetResend();
    const recipients = guestIds.map((guestId, i) => ({
      guestId, name: `Guest${i}`, email: `d-${i}@test.invalid`, inviteToken: 't', selfRegistered: false,
    }));
    const outcomes = await time('dispatch only', () =>
      inviteDispatchService.sendGuestMessages({ tenantId, createdByUserId: organiser.id }, recipients, () => ({
        from: '"x" <x@test.invalid>', subject: 's', html: '<p>h</p>', text: 't',
      }))
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(GUESTS);
  }, 600_000);

  it('invitations over HTTP', async () => {
    installFirebaseMock();
    resetResend();
    const res = await time('invitations (POST invites/send)', () =>
      request(app).post(`/api/events/${eventId}/invites/send`).set(headersFor(organiser)).send({ guestIds })
    );
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(GUESTS);
    expect(emailsSent()).toBe(GUESTS);
  }, 900_000);

  it('reminders over HTTP', async () => {
    installFirebaseMock();
    await invitedNotReminded();
    resetResend();
    const res = await time('reminders (POST invites/remind)', () =>
      request(app).post(`/api/events/${eventId}/invites/remind`).set(headersFor(organiser)).send({})
    );
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(GUESTS);
    expect(emailsSent()).toBe(GUESTS);
  }, 900_000);

  it('announcement over HTTP', async () => {
    installFirebaseMock();
    await invitedNotReminded();
    resetResend();
    const res = await time('announcement (POST announcements)', () =>
      request(app).post(`/api/events/${eventId}/announcements`).set(headersFor(organiser))
        .send({ subject: 'Buses', body: 'Buses leave at 18:00', audience: 'EVERYONE' })
    );
    expect(res.status).toBe(201);
    expect(res.body.data.sent).toBe(GUESTS);
    expect(emailsSent()).toBe(GUESTS);
  }, 900_000);

  it('cancellation over HTTP', async () => {
    installFirebaseMock();
    await invitedNotReminded();
    resetResend();
    const res = await time('cancellation (POST cancel)', () =>
      request(app).post(`/api/events/${eventId}/cancel`).set(headersFor(organiser)).send({})
    );
    expect(res.status).toBe(200);
    expect(res.body.data.guestNotification.sent).toBe(GUESTS);
    expect(emailsSent()).toBe(GUESTS);
  }, 900_000);
});
