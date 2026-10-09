import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend } from '../setup.js';
import { installFirebaseMock, headersFor, createActor, assign, createEventWithDay, type Actor } from '../helpers/team.js';
import { ANNOUNCEMENTS_PER_EVENT_PER_DAY } from '../../src/modules/announcement/announcement.service.js';
import {
  createAnnouncementEvent,
  createOtherTenant,
  addGuest,
  cleanupAnnouncementFixtures,
  sentEmails,
  prisma,
  type AnnouncementEventFixture,
  type FixtureGuest,
} from './helpers.js';

// ─────────────────────────────────────────
//  SENDING AN ANNOUNCEMENT: the email itself (the organiser's words
//  escaped, line breaks kept, the invitation's From and Reply-To, one button
//  to the guest's own invitation), the append-only history, the daily
//  limit, a cancelled event, every validation refusal, and who may send:
//  another tenant's event and a locked member's unassigned event are 404.
// ─────────────────────────────────────────

let fx: AnnouncementEventFixture;
let ana: FixtureGuest;
let ben: FixtureGuest;

beforeAll(async () => {
  fx = await createAnnouncementEvent();
  ana = await addGuest(fx, { name: 'Ana', status: 'ACCEPTED' });
  ben = await addGuest(fx, { name: 'Ben' });
}, 120000);

afterAll(async () => {
  await cleanupAnnouncementFixtures();
}, 120000);

const clearHistory = async (eventId: string) => {
  await prisma.announcementDelivery.deleteMany({ where: { announcement: { eventId } } });
  await prisma.announcement.deleteMany({ where: { eventId } });
};

beforeEach(async () => {
  installFirebaseMock();
  vi.unstubAllEnvs();
  await clearHistory(fx.eventId);
});

const base = { subject: 'Buses leave at 18:00', body: 'See you there', audience: 'EVERYONE' };

const sendAs = (actor: Actor, eventId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/events/${eventId}/announcements`).set(headersFor(actor)).send(body);
const send = (body: Record<string, unknown> = base, eventId = fx.eventId) => sendAs(fx.organiser, eventId, body);
const list = (actor: Actor = fx.organiser, eventId = fx.eventId) =>
  request(app).get(`/api/events/${eventId}/announcements`).set(headersFor(actor));
const preview = (actor: Actor = fx.organiser, eventId = fx.eventId) =>
  request(app).post(`/api/events/${eventId}/announcements/preview`).set(headersFor(actor)).send({ audience: 'EVERYONE' });

describe('the email', () => {
  it("escapes the organiser's body, keeps its line breaks, and links each guest to their own invitation", async () => {
    const body = 'Hi all,\r\n<script>alert(1)</script> & <b>bold</b>\n\nBuses leave at 18:00';
    const res = await send({ ...base, body });
    expect(res.status).toBe(201);

    const emails = sentEmails();
    expect(emails.map((e) => e.to).sort()).toEqual([ana.email, ben.email].sort());
    const toAna = emails.find((e) => e.to === ana.email)!;

    // Escaped: the markup arrives as text, never as markup.
    expect(toAna.html).not.toContain('<script>alert(1)</script>');
    expect(toAna.html).not.toContain('<b>bold</b>');
    expect(toAna.html).toContain('Hi all,<br>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;<br><br>Buses leave at 18:00');
    // The plain-text part is the body as written, its lines kept.
    expect(toAna.text).toContain('Hi all,\n<script>alert(1)</script> & <b>bold</b>\n\nBuses leave at 18:00');

    // Guest email headers, as an invitation's.
    expect(toAna.subject).toBe('Buses leave at 18:00');
    expect(toAna.from).toMatch(/^"Thandi & Sipho via e-velope" </);
    expect(toAna.replyTo).toBe(fx.organiser.email);

    // One button, to this guest's own invitation (and not the other's).
    expect(toAna.html).toContain('Open your e-velope');
    expect(toAna.html).toContain(`/rsvp?token=${ana.token}`);
    expect(toAna.html).not.toContain(ben.token);
    expect(toAna.html.match(/class="eg-button"/g)).toHaveLength(1);
  }, 60000);

  it('makes the subject header-safe: line breaks become spaces, and that is what the history keeps', async () => {
    const res = await send({ ...base, subject: 'Dress code\r\nBcc: someone@example.test' });
    expect(res.status).toBe(201);
    for (const e of sentEmails()) expect(e.subject).toBe('Dress code Bcc: someone@example.test');
    expect(res.body.data.announcement.subject).toBe('Dress code Bcc: someone@example.test');
  }, 60000);
});

describe('the history', () => {
  it('records each announcement once, with its outcome, and lists newest first', async () => {
    // Ben's email fails at the provider; Ana's goes.
    mockResendSend.mockImplementation(async (msg: { to: string }) =>
      msg.to === ben.email ? { data: null, error: { message: 'Mailbox unavailable' } } : { data: { id: 'ok' }, error: null }
    );
    const first = await send({ ...base, subject: 'First' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      sent: 1,
      failed: 1,
      failures: [{ guestId: ben.guestId, name: 'Ben Guest', email: ben.email, reason: 'Mailbox unavailable' }],
      unreachableCount: 0,
      unreachable: [],
    });
    expect(first.body.data.announcement).toMatchObject({
      kind: 'ANNOUNCEMENT',
      subject: 'First',
      body: 'See you there',
      audience: 'EVERYONE',
      eventDayId: null,
      sentBy: fx.organiser.id,
      recipientCount: 2,
      failureCount: 1,
      unreachableCount: 0,
    });

    mockResendSend.mockResolvedValue({ data: { id: 'ok' }, error: null });
    await new Promise((r) => setTimeout(r, 20));
    const second = await send({ ...base, subject: 'Second', audience: 'ATTENDING' });
    expect(second.status).toBe(201);

    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { subject: string }) => a.subject)).toEqual(['Second', 'First']);
    expect(res.body.data[1]).toEqual({ ...first.body.data.announcement });
    expect(res.body.data[0]).toMatchObject({ audience: 'ATTENDING', recipientCount: 1, failureCount: 0 });

    // One delivery row per guest emailed.
    const deliveries = await prisma.announcementDelivery.findMany({ where: { announcementId: first.body.data.announcement.id } });
    expect(deliveries.map((d) => [d.guestId, d.succeeded, d.failureReason]).sort()).toEqual(
      [[ana.guestId, true, null], [ben.guestId, false, 'Mailbox unavailable']].sort()
    );
  }, 60000);
});

describe('the daily limit', () => {
  it(`allows ${ANNOUNCEMENTS_PER_EVENT_PER_DAY} in 24 hours, then 429 with a code, sending and recording nothing`, async () => {
    for (let i = 1; i <= ANNOUNCEMENTS_PER_EVENT_PER_DAY; i++) {
      expect((await send({ ...base, subject: `Update ${i}` })).status).toBe(201);
    }
    mockResendSend.mockClear();
    const refused = await send({ ...base, subject: 'One too many' });
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('ANNOUNCEMENT_DAILY_LIMIT');
    expect(refused.body.message).toMatch(/You can send the next one from \d\d:\d\d UTC on /);
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(ANNOUNCEMENTS_PER_EVENT_PER_DAY);
  }, 120000);

  it('counts only the last 24 hours, and only this event', async () => {
    for (let i = 0; i < ANNOUNCEMENTS_PER_EVENT_PER_DAY; i++) {
      await prisma.announcement.create({
        data: {
          eventId: fx.eventId, kind: 'ANNOUNCEMENT', subject: `Old ${i}`, body: 'x', audience: 'EVERYONE',
          sentBy: fx.organiser.id, sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000), recipientCount: 2, unreachableCount: 0,
        },
      });
    }
    expect((await send()).status).toBe(201);
  }, 60000);

  it('holds when sends race: never more than the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: ANNOUNCEMENTS_PER_EVENT_PER_DAY + 2 }, (_, i) => send({ ...base, subject: `Race ${i}` }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(ANNOUNCEMENTS_PER_EVENT_PER_DAY);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(ANNOUNCEMENTS_PER_EVENT_PER_DAY);
  }, 120000);
});

describe('refusals', () => {
  it('each invalid field is 422 with its code; a wrong type is 400', async () => {
    const other = await createAnnouncementEvent();
    const cases: [Record<string, unknown>, number, string | undefined][] = [
      [{ ...base, subject: '   ' }, 422, 'ANNOUNCEMENT_SUBJECT_REQUIRED'],
      [{ ...base, subject: undefined }, 422, 'ANNOUNCEMENT_SUBJECT_REQUIRED'],
      [{ ...base, subject: 'x'.repeat(151) }, 422, 'ANNOUNCEMENT_SUBJECT_TOO_LONG'],
      [{ ...base, body: ' \n ' }, 422, 'ANNOUNCEMENT_BODY_REQUIRED'],
      [{ ...base, body: 'x'.repeat(5001) }, 422, 'ANNOUNCEMENT_BODY_TOO_LONG'],
      [{ ...base, audience: undefined }, 422, 'ANNOUNCEMENT_AUDIENCE_INVALID'],
      [{ ...base, audience: 'VIPS' }, 422, 'ANNOUNCEMENT_AUDIENCE_INVALID'],
      [{ ...base, eventDayId: other.dayIds[0] }, 422, 'ANNOUNCEMENT_DAY_INVALID'],
      [{ ...base, subject: 42 }, 400, undefined],
      [{ ...base, body: ['x'] }, 400, undefined],
      [{ ...base, audience: 1 }, 400, undefined],
    ];
    for (const [body, status, code] of cases) {
      const res = await send(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(res.body.code).toBe(code);
    }
    // At the limits exactly: accepted.
    expect((await send({ ...base, subject: 's'.repeat(150), body: 'b'.repeat(5000) })).status).toBe(201);
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(1);
  }, 120000);

  it('an audience nobody is in is 422 ANNOUNCEMENT_NO_RECIPIENTS, and records nothing', async () => {
    const res = await send({ ...base, audience: 'NOT_ATTENDING' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ANNOUNCEMENT_NO_RECIPIENTS');
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(0);
  }, 30000);

  it('a cancelled event is 409 for preview and send; its history still lists', async () => {
    const cancelled = await createAnnouncementEvent({ event: { status: 'CANCELLED' } });
    await addGuest(cancelled, { name: 'Cleo' });
    const res = await sendAs(cancelled.organiser, cancelled.eventId, base);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("This event has been cancelled, so announcements can't be sent.");
    expect((await preview(cancelled.organiser, cancelled.eventId)).status).toBe(409);
    expect((await list(cancelled.organiser, cancelled.eventId)).status).toBe(200);
    expect(mockResendSend).not.toHaveBeenCalled();
  }, 60000);
});

describe('who may send', () => {
  it("another tenant's event is 404 on every route", async () => {
    const tenant = await createOtherTenant();
    const stranger = await createActor('TENANT_ADMIN', tenant.id);
    expect((await sendAs(stranger, fx.eventId, base)).status).toBe(404);
    expect((await preview(stranger)).status).toBe(404);
    expect((await list(stranger)).status).toBe(404);
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(await prisma.announcement.count({ where: { eventId: fx.eventId } })).toBe(0);
  }, 60000);

  it("a locked member's unassigned event is 404 on every route; an unlocked member may send", async () => {
    const member = await createActor('EVENT_ADMIN', fx.tenantId);
    expect((await preview(member)).status).toBe(200);

    const { event: elsewhere } = await createEventWithDay(fx.tenantId, fx.organiser.id, 'Another event');
    await assign(fx.tenantId, member.id, elsewhere.id, fx.organiser.id);
    expect((await sendAs(member, fx.eventId, base)).status).toBe(404);
    expect((await preview(member)).status).toBe(404);
    expect((await list(member)).status).toBe(404);
    expect(mockResendSend).not.toHaveBeenCalled();

    await assign(fx.tenantId, member.id, fx.eventId, fx.organiser.id);
    expect((await sendAs(member, fx.eventId, base)).status).toBe(201);
  }, 60000);

  it('with announcements switched off, every route is 404', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'announcements');
    expect((await send()).status).toBe(404);
    expect((await preview()).status).toBe(404);
    expect((await list()).status).toBe(404);
    expect(mockResendSend).not.toHaveBeenCalled();
  }, 30000);
});
