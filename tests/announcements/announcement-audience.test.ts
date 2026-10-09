import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend } from '../setup.js';
import { installFirebaseMock, headersFor } from '../helpers/team.js';
import {
  createAnnouncementEvent,
  addGuest,
  cleanupAnnouncementFixtures,
  sentTo,
  prisma,
  type AnnouncementEventFixture,
  type FixtureGuest,
} from './helpers.js';

// ─────────────────────────────────────────
//  WHO AN ANNOUNCEMENT REACHES, end to end: every audience, with and
//  without a day, sent for real over HTTP (Resend mocked) and checked
//  against exactly who got an email and who was reported unreachable.
//  The preview's counts must say the same.
//
//  One two-day event, one guest per case:
//    A  accepted, both days            G  not replied, no email
//    B  accepted, day 1 only           L  accepted day 2 only, no email
//    C  not replied, both days         H  archived guest
//    D  declined                       I  archived invite
//    E  not replied, invited to day 2  J  invitation never delivered
//    F  self-registered (never         K  A's plus-one, with an email
//       "delivered"), day 1 only
// ─────────────────────────────────────────

let fx: AnnouncementEventFixture;
let D1: string;
let D2: string;
const g: Record<string, FixtureGuest> = {};

beforeAll(async () => {
  fx = await createAnnouncementEvent({ days: 2 });
  [D1, D2] = fx.dayIds as [string, string];
  g['A'] = await addGuest(fx, { name: 'A', status: 'ACCEPTED' });
  g['B'] = await addGuest(fx, { name: 'B', status: 'ACCEPTED', attendingDayIds: [D1] });
  g['C'] = await addGuest(fx, { name: 'C' });
  g['D'] = await addGuest(fx, { name: 'D', status: 'DECLINED' });
  g['E'] = await addGuest(fx, { name: 'E', invitedDayIds: [D2] });
  g['F'] = await addGuest(fx, { name: 'F', status: 'ACCEPTED', attendingDayIds: [D1], selfRegistered: true, delivered: false });
  g['G'] = await addGuest(fx, { name: 'G', email: null, phoneNumber: '+27825550001' });
  g['L'] = await addGuest(fx, { name: 'L', status: 'ACCEPTED', attendingDayIds: [D2], email: null, phoneNumber: '+27825550002' });
  g['H'] = await addGuest(fx, { name: 'H', archivedGuest: true });
  g['I'] = await addGuest(fx, { name: 'I', archivedInvite: true });
  g['J'] = await addGuest(fx, { name: 'J', delivered: false });
  g['K'] = await addGuest(fx, { name: 'K', status: 'ACCEPTED', hostGuestId: g['A'].guestId });
}, 120000);

afterAll(async () => {
  await cleanupAnnouncementFixtures();
}, 120000);

beforeEach(() => {
  installFirebaseMock();
});

const emailsOf = (...names: string[]) => names.map((n) => g[n]!.email!).sort();

// Sends one announcement and returns who was emailed and who was reported
// unreachable. The history is cleared first so the daily limit never gets
// in the way of a test that isn't about it.
const send = async (audience: string, eventDayId?: string) => {
  await prisma.announcementDelivery.deleteMany({ where: { announcement: { eventId: fx.eventId } } });
  await prisma.announcement.deleteMany({ where: { eventId: fx.eventId } });
  mockResendSend.mockClear();
  const res = await request(app)
    .post(`/api/events/${fx.eventId}/announcements`)
    .set(headersFor(fx.organiser))
    .send({ subject: 'Buses', body: 'Buses leave at 18:00', audience, ...(eventDayId ? { eventDayId } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    to: sentTo(),
    unreachable: (res.body.data.unreachable as { name: string }[]).map((u) => u.name.split(' ')[0]).sort(),
    body: res.body.data,
  };
};

const preview = (audience: string, eventDayId?: string) =>
  request(app)
    .post(`/api/events/${fx.eventId}/announcements/preview`)
    .set(headersFor(fx.organiser))
    .send({ audience, ...(eventDayId ? { eventDayId } : {}) });

const cases: { audience: string; day: 'D1' | 'D2' | null; to: string[]; unreachable: string[] }[] = [
  { audience: 'EVERYONE', day: null, to: ['A', 'B', 'C', 'E', 'F'], unreachable: ['G', 'L'] },
  { audience: 'ATTENDING', day: null, to: ['A', 'B', 'F'], unreachable: ['L'] },
  { audience: 'NOT_REPLIED', day: null, to: ['C', 'E'], unreachable: ['G'] },
  { audience: 'NOT_ATTENDING', day: null, to: ['D'], unreachable: [] },
  { audience: 'EVERYONE', day: 'D1', to: ['A', 'B', 'C', 'F'], unreachable: ['G'] },
  { audience: 'ATTENDING', day: 'D1', to: ['A', 'B', 'F'], unreachable: [] },
  { audience: 'NOT_REPLIED', day: 'D1', to: ['C'], unreachable: ['G'] },
  { audience: 'NOT_ATTENDING', day: 'D1', to: ['D'], unreachable: ['L'] },
  { audience: 'EVERYONE', day: 'D2', to: ['A', 'C', 'E'], unreachable: ['G', 'L'] },
  { audience: 'ATTENDING', day: 'D2', to: ['A'], unreachable: ['L'] },
  { audience: 'NOT_REPLIED', day: 'D2', to: ['C', 'E'], unreachable: ['G'] },
  { audience: 'NOT_ATTENDING', day: 'D2', to: ['B', 'D', 'F'], unreachable: [] },
];

describe('each audience reaches exactly the right guests', () => {
  for (const c of cases) {
    it(`${c.audience}${c.day ? ` on ${c.day}` : ''}`, async () => {
      const dayId = c.day === 'D1' ? D1 : c.day === 'D2' ? D2 : undefined;
      const result = await send(c.audience, dayId);
      expect(result.to).toEqual(emailsOf(...c.to));
      expect(result.unreachable).toEqual(c.unreachable);
      expect(result.body.sent).toBe(c.to.length);
      expect(result.body.unreachableCount).toBe(c.unreachable.length);

      // The history records the same numbers.
      const row = await prisma.announcement.findFirstOrThrow({ where: { eventId: fx.eventId } });
      expect(row.recipientCount).toBe(c.to.length);
      expect(row.unreachableCount).toBe(c.unreachable.length);
      expect(row.audience).toBe(c.audience);
      expect(row.eventDayId).toBe(dayId ?? null);

      const p = await preview(c.audience, dayId);
      expect(p.status).toBe(200);
      expect(p.body.data.recipientCount).toBe(c.to.length);
      expect(p.body.data.unreachableCount).toBe(c.unreachable.length);
    }, 60000);
  }
});

describe('never reached', () => {
  it('archived guests and invites, guests never invited, and plus-ones get nothing in any audience', async () => {
    const never = emailsOf('H', 'I', 'J', 'K');
    for (const c of cases.filter((x) => x.day === null)) {
      const { to } = await send(c.audience);
      for (const address of never) expect(to).not.toContain(address);
    }
  }, 120000);
});

describe('guests without an email', () => {
  it('are counted and listed by the preview, with their phone, never silently skipped', async () => {
    const res = await preview('EVERYONE');
    expect(res.body.data).toEqual({
      audience: 'EVERYONE',
      eventDayId: null,
      recipientCount: 5,
      unreachableCount: 2,
      unreachable: expect.arrayContaining([
        { guestId: g['G']!.guestId, name: 'G Guest', phoneNumber: '+27825550001' },
        { guestId: g['L']!.guestId, name: 'L Guest', phoneNumber: '+27825550002' },
      ]),
    });
  }, 30000);
});
