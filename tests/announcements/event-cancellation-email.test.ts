import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { installFirebaseMock, headersFor } from '../helpers/team.js';
import { ANNOUNCEMENTS_PER_EVENT_PER_DAY } from '../../src/modules/announcement/announcement.service.js';
import { announcementRepository } from '../../src/modules/announcement/announcement.repository.js';
import {
  createAnnouncementEvent,
  addGuest,
  cleanupAnnouncementFixtures,
  sentEmails,
  sentTo,
  clearSentEmails,
  failEmailsTo,
  prisma,
  type AnnouncementEventFixture,
} from './helpers.js';

// ─────────────────────────────────────────
//  THE CANCELLATION EMAIL: cancelling an event emails every invited guest
//  who hasn't declined (no RSVP button, the event's dates, the organiser's
//  note escaped), records it in the announcement history, and still
//  cancels when emails fail, reporting the failures. A too-long note
//  cancels nothing. Never refused by the daily limit.
// ─────────────────────────────────────────

afterAll(async () => {
  await cleanupAnnouncementFixtures();
}, 120000);

beforeEach(() => {
  installFirebaseMock();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const cancel = (fx: AnnouncementEventFixture, body?: Record<string, unknown>) => {
  const req = request(app).post(`/api/events/${fx.eventId}/cancel`).set(headersFor(fx.organiser));
  return body ? req.send(body) : req;
};

const setup = async (event: Record<string, unknown> = {}) => {
  const fx = await createAnnouncementEvent({ days: 2, event: { name: 'Garden Party', ...event } });
  const guests = {
    accepted: await addGuest(fx, { name: 'Ana', status: 'ACCEPTED' }),
    pending: await addGuest(fx, { name: 'Ben' }),
    registered: await addGuest(fx, { name: 'Reg', status: 'ACCEPTED', selfRegistered: true, delivered: false }),
    declined: await addGuest(fx, { name: 'Dee', status: 'DECLINED' }),
    neverSent: await addGuest(fx, { name: 'Ned', delivered: false }),
    noEmail: await addGuest(fx, { name: 'Pho', email: null, phoneNumber: '+27825550003' }),
    archived: await addGuest(fx, { name: 'Arc', archivedGuest: true }),
  };
  return { fx, guests };
};

describe('cancelling an event', () => {
  it("emails every invited guest who hasn't declined, without a button, and records it", async () => {
    const { fx, guests } = await setup();
    const res = await cancel(fx, { note: 'So sorry.\n<b>New date</b> soon' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');

    expect(sentTo()).toEqual([guests.accepted.email, guests.pending.email, guests.registered.email].sort());

    const email = sentEmails().find((e) => e.to === guests.pending.email)!;
    expect(email.subject).toBe('Garden Party has been cancelled');
    expect(email.from).toMatch(/^"Thandi & Sipho via e-velope" </);
    expect(email.replyTo).toBe(fx.organiser.email);
    // No RSVP button, no link to the invitation.
    expect(email.html).not.toContain('class="eg-button"');
    expect(email.html).not.toContain('/rsvp?token=');
    expect(email.html).not.toContain(guests.pending.token);
    // The event's name and dates, both days, labelled.
    expect(email.html).toContain('Garden Party');
    expect(email.html).toContain('Day 1');
    expect(email.html).toContain('Day 2');
    expect(email.text).toContain('1 March 2027');
    expect(email.text).toContain('2 March 2027');
    // The note, escaped, its line breaks kept.
    expect(email.html).toContain('So sorry.<br>&lt;b&gt;New date&lt;/b&gt; soon');
    expect(email.html).not.toContain('<b>New date</b>');

    expect(res.body.data.guestNotification).toMatchObject({
      sent: 3,
      failed: 0,
      failures: [],
      unreachableCount: 1,
      unreachable: [{ guestId: guests.noEmail.guestId, name: 'Pho Guest', phoneNumber: '+27825550003' }],
      announcement: {
        kind: 'CANCELLATION',
        subject: 'Garden Party has been cancelled',
        body: 'So sorry.\n<b>New date</b> soon',
        audience: 'EVERYONE',
        recipientCount: 3,
        failureCount: 0,
        unreachableCount: 1,
        sentBy: fx.organiser.id,
      },
    });

    const history = await request(app).get(`/api/events/${fx.eventId}/announcements`).set(headersFor(fx.organiser));
    expect(history.status).toBe(200);
    expect(history.body.data.announcements).toHaveLength(1);
    expect(history.body.data.announcements[0]).toEqual(res.body.data.guestNotification.announcement);
    // The cancellation email never counts against the daily limit.
    expect(history.body.data.dailyLimit).toMatchObject({ sentInWindow: 0, remaining: 5 });
  }, 120000);

  it('still cancels when emails fail, and reports each failure', async () => {
    const { fx, guests } = await setup();
    failEmailsTo([guests.accepted.email!], 'Mailbox full');
    const res = await cancel(fx);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.data.guestNotification).toMatchObject({
      sent: 2,
      failed: 1,
      failures: [{ guestId: guests.accepted.guestId, name: 'Ana Guest', email: guests.accepted.email, reason: 'Mailbox full' }],
      announcement: { failureCount: 1, recipientCount: 3, body: null },
    });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: fx.eventId } })).status).toBe('CANCELLED');
  }, 120000);

  it("couldn't be sent at all: the event is cancelled, guests are to be contacted directly, and everyone not reached is listed", async () => {
    const { fx, guests } = await setup();
    // The record can't be written, so nothing is sent.
    vi.spyOn(announcementRepository, 'create').mockRejectedValueOnce(new Error('connection lost'));

    const res = await cancel(fx);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    const notice = res.body.data.guestNotification;
    // Never "send an announcement": a cancelled event refuses them.
    expect(notice.error).not.toMatch(/announcement/i);
    expect(notice.error).toBe(
      "Your event is cancelled, but we couldn't email your guests about it. Please contact them directly: every guest who wasn't reached is listed."
    );
    expect(notice).toMatchObject({ announcement: null, sent: 0, failed: 3, unreachableCount: 1 });
    expect(notice.failures.map((f: { guestId: string }) => f.guestId).sort()).toEqual(
      [guests.accepted.guestId, guests.pending.guestId, guests.registered.guestId].sort()
    );
    expect(notice.failures[0]).toMatchObject({ reason: "The cancellation email couldn't be sent.", email: expect.stringContaining('@') });
    expect(notice.unreachable).toEqual([{ guestId: guests.noEmail.guestId, name: 'Pho Guest', phoneNumber: '+27825550003' }]);
    expect(sentEmails()).toHaveLength(0);
  }, 120000);

  it("couldn't even load who to tell: says so, and points at the guest list", async () => {
    const { fx } = await setup();
    vi.spyOn(announcementRepository, 'findAudienceGuests').mockRejectedValueOnce(new Error('connection lost'));

    const res = await cancel(fx);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.data.guestNotification).toEqual({
      announcement: null, sent: 0, failed: 0, failures: [], unreachableCount: 0, unreachable: [],
      error: "Your event is cancelled, but we couldn't email your guests about it, or load the list of who should have been told. Please contact your guests directly, using your guest list.",
    });
  }, 120000);

  it('a note over 1000 characters is 422 and cancels nothing; a wrong type is 400', async () => {
    const { fx } = await setup();
    const long = await cancel(fx, { note: 'x'.repeat(1001) });
    expect(long.status).toBe(422);
    expect(long.body.code).toBe('CANCELLATION_NOTE_TOO_LONG');
    expect((await cancel(fx, { note: 5 })).status).toBe(400);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: fx.eventId } })).status).toBe('PUBLISHED');
    expect(sentEmails()).toHaveLength(0);

    expect((await cancel(fx, { note: 'x'.repeat(1000) })).status).toBe(200);
  }, 120000);

  it('a second cancel is 409 and emails nobody again', async () => {
    const { fx } = await setup();
    expect((await cancel(fx)).status).toBe(200);
    clearSentEmails();
    const again = await cancel(fx);
    expect(again.status).toBe(409);
    expect(sentEmails()).toHaveLength(0);
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(1);
  }, 120000);

  it('two cancels racing email guests once', async () => {
    const { fx } = await setup();
    const results = await Promise.all([cancel(fx), cancel(fx)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sentEmails()).toHaveLength(3);
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(1);
  }, 120000);

  it('is never refused by the daily announcement limit', async () => {
    const { fx } = await setup();
    for (let i = 0; i < ANNOUNCEMENTS_PER_EVENT_PER_DAY; i++) {
      const sent = await request(app)
        .post(`/api/events/${fx.eventId}/announcements`)
        .set(headersFor(fx.organiser))
        .send({ subject: `Update ${i}`, body: 'x', audience: 'EVERYONE' });
      expect(sent.status).toBe(201);
    }
    clearSentEmails();
    const res = await cancel(fx);
    expect(res.status).toBe(200);
    expect(res.body.data.guestNotification.sent).toBe(3);
  }, 180000);

  it('a draft (nobody invited yet) cancels with no emails and nothing recorded', async () => {
    const fx = await createAnnouncementEvent({ event: { status: 'DRAFT' } });
    await addGuest(fx, { name: 'Ned', delivered: false });
    const res = await cancel(fx);
    expect(res.status).toBe(200);
    expect(res.body.data.guestNotification).toEqual({
      announcement: null, sent: 0, failed: 0, failures: [], unreachableCount: 0, unreachable: [],
    });
    expect(sentEmails()).toHaveLength(0);
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(0);
  }, 60000);

  it('an event whose last day has passed is 409 EVENT_ALREADY_HAPPENED: nothing cancelled, emailed or recorded', async () => {
    const { fx } = await setup();
    // Both days in the past: the event reads COMPLETED (derived; stored PUBLISHED).
    await prisma.eventDay.updateMany({ where: { eventId: fx.eventId }, data: { date: new Date('2025-01-01') } });

    const res = await cancel(fx, { note: 'Sorry' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      status: 'error',
      message: 'This event has already taken place, so it can no longer be cancelled.',
      code: 'EVENT_ALREADY_HAPPENED',
    });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: fx.eventId } })).status).toBe('PUBLISHED');
    expect(sentEmails()).toHaveLength(0);
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(0);

    // The last day still to come: cancelling works.
    await prisma.eventDay.updateMany({ where: { eventId: fx.eventId }, data: { date: new Date('2027-03-01') } });
    expect((await cancel(fx)).status).toBe(200);
  }, 120000);

  it('with announcements switched off, cancelling still works and emails nobody', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'announcements');
    const { fx } = await setup();
    const res = await cancel(fx, { note: 'Sorry' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.data.guestNotification).toBeNull();
    expect(sentEmails()).toHaveLength(0);
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(0);
  }, 120000);
});
