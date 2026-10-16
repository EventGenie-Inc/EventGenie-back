import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { claimEventEmails, EVENT_EMAILS_PER_DAY } from '../../src/modules/invite/event-email-limit.util.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';

// ─────────────────────────────────────────
//  SAFETY LIMITS — invitation and reminder emails per event per day
//
//  At most 2,000 in any rolling 24 hours, counted when a send is claimed,
//  all-or-nothing: 429 EVENT_EMAIL_DAILY_LIMIT and nothing goes. The window
//  is seeded with claim rows rather than thousands of real sends; the sends
//  themselves are real (Resend mocked, tests/setup.ts).
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let eventId: string;
let dayId: string;

beforeEach(async () => {
  installFirebaseMock();
  clearSentEmails();
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  const created = await createEventWithDay(tenant.id, organiser.id);
  eventId = created.event.id;
  dayId = created.day.id;
}, 60000);

afterEach(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
}, 120000);

const addGuests = async (count: number) => {
  const guests = [];
  for (let i = 0; i < count; i++) {
    guests.push(
      await guestRepository.createWithInvite(eventId, organiser.id, {
        firstName: `Guest ${i}`,
        surname: null,
        email: `limit-${randomUUID()}@test.invalid`,
        phoneNumber: null,
        eventDayIds: [dayId],
        plusOnesAllowed: 0,
      })
    );
  }
  return guests;
};

// Emails already counted in the window (or before it).
const seedClaim = (emailCount: number, hoursAgo = 1) =>
  prisma.eventEmailClaim.create({
    data: { eventId, kind: 'INVITATION', emailCount, claimedBy: organiser.id, claimedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) },
  });

const send = (guestIds: string[]) =>
  request(app).post(`/api/events/${eventId}/invites/send`).set(headersFor(organiser)).send({ guestIds });

describe('invitations', () => {
  it('a send that would pass 2,000 in 24 hours is 429 with the code, and nothing goes', async () => {
    const guests = await addGuests(2);
    await seedClaim(EVENT_EMAILS_PER_DAY - 1);

    const res = await send(guests.map((g) => g.guest.id));
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      status: 'error',
      message:
        'This would send 2 emails, but only 1 more can go from this event in the next 24 hours ' +
        '(the limit is 2,000 invitation and reminder emails a day). Nothing was sent. Choose fewer guests, or try again later.',
      code: 'EVENT_EMAIL_DAILY_LIMIT',
    });
    expect(sentEmails()).toHaveLength(0);
    expect(await prisma.invite.count({ where: { eventId, deliveredAt: { not: null } } })).toBe(0);
    expect(await prisma.eventEmailClaim.count({ where: { eventId } })).toBe(1);

    // The one that fits goes, and is counted.
    const one = await send([guests[0]!.guest.id]);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ sent: 1, failed: 0 });
    expect(sentEmails()).toHaveLength(1);
    expect(await prisma.eventEmailClaim.findFirst({ where: { eventId, emailCount: 1 } })).toMatchObject({ kind: 'INVITATION', claimedBy: organiser.id });

    // Now full: even a single resend is refused, with the "none left" wording.
    const resend = await request(app)
      .post(`/api/events/${eventId}/invites/${guests[1]!.invite.id}/resend`)
      .set(headersFor(organiser));
    expect(resend.status).toBe(429);
    expect(resend.body.code).toBe('EVENT_EMAIL_DAILY_LIMIT');
    expect(resend.body.message).toMatch(/^This event has sent the most invitation and reminder emails allowed in 24 hours \(2,000\)\. Nothing was sent\./);
    expect(sentEmails()).toHaveLength(1);
  }, 60000);

  it('the window rolls: emails claimed more than 24 hours ago no longer count', async () => {
    const guests = await addGuests(1);
    await seedClaim(EVENT_EMAILS_PER_DAY, 25);
    const res = await send([guests[0]!.guest.id]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sent: 1 });
  }, 60000);

  it('another event’s sends never count against this one', async () => {
    const guests = await addGuests(1);
    const other = await createEventWithDay(organiser.tenantId!, organiser.id);
    await prisma.eventEmailClaim.create({
      data: { eventId: other.event.id, kind: 'INVITATION', emailCount: EVENT_EMAILS_PER_DAY, claimedBy: organiser.id },
    });
    expect((await send([guests[0]!.guest.id])).status).toBe(200);
  }, 60000);
});

describe('reminders', () => {
  it('a reminder round past the limit is 429 with the code: nobody reminded, no cooldown started, nothing logged', async () => {
    const guests = await addGuests(2);
    await prisma.invite.updateMany({ where: { eventId }, data: { deliveredAt: new Date(Date.now() - 48 * 60 * 60 * 1000) } });
    await seedClaim(EVENT_EMAILS_PER_DAY - 1);

    const res = await request(app).post(`/api/events/${eventId}/invites/remind`).set(headersFor(organiser)).send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('EVENT_EMAIL_DAILY_LIMIT');
    expect(sentEmails()).toHaveLength(0);
    for (const { invite } of guests) {
      expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).lastRemindedAt).toBeNull();
    }
    expect(await prisma.inviteReminderLog.count({ where: { eventId } })).toBe(0);

    // With room, the same round goes and is counted as reminders.
    await prisma.eventEmailClaim.deleteMany({ where: { eventId } });
    const ok = await request(app).post(`/api/events/${eventId}/invites/remind`).set(headersFor(organiser)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ sent: 2 });
    expect(await prisma.eventEmailClaim.findFirst({ where: { eventId } })).toMatchObject({ kind: 'REMINDER', emailCount: 2 });
    await prisma.inviteReminderLog.deleteMany({ where: { eventId } });
  }, 60000);
});

describe('the allowance itself', () => {
  it('a 300-guest event’s invitations and a reminder round fit with room to spare', async () => {
    await claimEventEmails(eventId, 'INVITATION', 300, organiser.id);
    await claimEventEmails(eventId, 'REMINDER', 300, organiser.id);
    await claimEventEmails(eventId, 'INVITATION', 1000, organiser.id);
    await expect(claimEventEmails(eventId, 'INVITATION', 401, organiser.id)).rejects.toMatchObject({ statusCode: 429 });
  }, 60000);

  it('two sends racing for the last room: exactly one is claimed', async () => {
    await seedClaim(EVENT_EMAILS_PER_DAY - 300);
    const results = await Promise.allSettled([
      claimEventEmails(eventId, 'INVITATION', 300, organiser.id),
      claimEventEmails(eventId, 'REMINDER', 300, organiser.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const total = await prisma.eventEmailClaim.aggregate({ where: { eventId }, _sum: { emailCount: true } });
    expect(total._sum.emailCount).toBe(EVENT_EMAILS_PER_DAY);
  }, 60000);
});
