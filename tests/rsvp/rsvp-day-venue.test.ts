import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend } from '../setup.js';
import { inviteDispatchService } from '../../src/modules/invite/invite-dispatch.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  GUESTS SEE EACH DAY'S OWN VENUE
//
//  The venue belongs to the event day. A two-day event whose days are at
//  different venues (plus an archived third day): GET /api/rsvp/validate
//  gives each invited day its venue, POST /api/rsvp/program gives each
//  day its venue, and the invitation email a guest is actually sent names
//  their own day(s) and venue(s) — one line per day when invited to
//  several, a Date + Venue pair when invited to one — never the archived
//  day and never the retired event-level venue.
// ─────────────────────────────────────────

const CEREMONY = { location: 'St George\'s Cathedral', address: '5 Wale St, Cape Town', latitude: -33.925, longitude: 18.419 };
const BRUNCH = { location: 'Kirstenbosch Tea Room', address: 'Rhodes Dr, Newlands', latitude: null, longitude: null };

let tenantId: string;
let userId: string;
let eventId: string;
let ceremonyId: string;
let brunchId: string;
let bothGuest: { guestId: string; token: string };
let oneDayGuest: { guestId: string; token: string };

beforeAll(async () => {
  tenantId = (await createTestTenant()).id;
  userId = (await createTestUserRow({ role: 'TENANT_ADMIN', tenantId })).id;
  const event = await createTestEvent(tenantId, userId);
  eventId = event.id;
  // The retired event-level column holds something else entirely: nothing
  // guest-facing may show it.
  await prisma.event.update({ where: { id: eventId }, data: { location: 'RETIRED EVENT VENUE', address: 'RETIRED' } });

  const day = (label: string, date: string, venue: typeof CEREMONY | typeof BRUNCH, isArchived = false) =>
    prisma.eventDay.create({
      data: { eventId, label, date: new Date(date), ...venue, isArchived, createdBy: userId, updatedBy: userId },
    });
  // Created out of date order on purpose — responses must sort by date.
  brunchId = (await day('Brunch', '2027-06-06', BRUNCH)).id;
  ceremonyId = (await day('Ceremony', '2027-06-05', CEREMONY)).id;
  const archivedId = (await day('Rehearsal', '2027-06-04', { ...BRUNCH, location: 'ARCHIVED VENUE' }, true)).id;

  const both = await createTestGuestWithInvite(eventId, userId, [brunchId, ceremonyId, archivedId]);
  bothGuest = { guestId: both.guest.id, token: both.invite.token };
  const one = await createTestGuestWithInvite(eventId, userId, [brunchId]);
  oneDayGuest = { guestId: one.guest.id, token: one.invite.token };

  const program = await prisma.eventProgram.create({
    data: { eventId, title: 'Programme', isPublished: true, createdBy: userId, updatedBy: userId },
  });
  await prisma.programItem.createMany({
    data: [
      { programId: program.id, title: 'Vows', startTime: new Date('2027-06-05T14:00:00Z'), order: 0, createdBy: userId, updatedBy: userId },
      { programId: program.id, title: 'Brunch', startTime: new Date('2027-06-06T10:00:00Z'), order: 1, createdBy: userId, updatedBy: userId },
    ],
  });
}, 90000);

afterAll(async () => {
  await deleteTestGuest(bothGuest.guestId);
  await deleteTestGuest(oneDayGuest.guestId);
  const program = await prisma.eventProgram.findUnique({ where: { eventId } });
  if (program) {
    await prisma.programItem.deleteMany({ where: { programId: program.id } });
    await prisma.eventProgram.delete({ where: { id: program.id } });
  }
  await prisma.smsSendLog.deleteMany({ where: { eventId } });
  await prisma.eventDay.deleteMany({ where: { eventId } });
  await deleteTestEvent(eventId);
  await deleteTestUserRow(userId);
  await deleteTestTenant(tenantId);
  await prisma.$disconnect();
}, 90000);

describe('guest responses carry per-day venues', () => {
  it('/rsvp/validate: each invited day has its own venue; the compatibility fields are the first day\'s', async () => {
    const res = await request(app).get(`/api/rsvp/validate/${bothGuest.token}`);
    expect(res.status).toBe(200);
    const days = res.body.data.invite.inviteEventDay.map((d: { eventDay: Record<string, unknown> }) => d.eventDay);
    expect(days).toHaveLength(2); // archived day excluded
    expect(days[0]).toMatchObject({ id: ceremonyId, label: 'Ceremony', ...CEREMONY });
    expect(days[1]).toMatchObject({ id: brunchId, label: 'Brunch', ...BRUNCH });
    expect(res.body.data.invite.event).toMatchObject({
      location: CEREMONY.location,
      address: CEREMONY.address,
      latitude: CEREMONY.latitude,
      longitude: CEREMONY.longitude,
    });
    expect(JSON.stringify(res.body)).not.toContain('RETIRED');
  }, 60000);

  it('/rsvp/program: each day carries its venue', async () => {
    const res = await request(app).post('/api/rsvp/program').send({ token: bothGuest.token });
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.days).toEqual([
      expect.objectContaining({ eventDayId: ceremonyId, ...CEREMONY, items: [expect.objectContaining({ title: 'Vows' })] }),
      expect.objectContaining({ eventDayId: brunchId, ...BRUNCH, items: [expect.objectContaining({ title: 'Brunch' })] }),
    ]);
  }, 60000);

  it('invitation emails name the guest\'s own day(s) and venue(s)', async () => {
    const result = await inviteDispatchService.sendBulk(eventId, [bothGuest.guestId, oneDayGuest.guestId], 'TENANT_ADMIN', tenantId);
    expect(result).toMatchObject({ sent: 2, failed: 0 });

    const htmlFor = async (guestId: string) => {
      const guest = await prisma.guest.findUniqueOrThrow({ where: { id: guestId } });
      const call = mockResendSend.mock.calls.find(([arg]) => (arg as { to: string }).to === guest.email);
      return (call?.[0] as { html: string }).html;
    };

    const multi = await htmlFor(bothGuest.guestId);
    expect(multi).toContain('Your days:');
    expect(multi).toContain('<strong>Ceremony</strong> — 5 June 2027 — St George&#39;s Cathedral, 5 Wale St, Cape Town');
    expect(multi).toContain('<strong>Brunch</strong> — 6 June 2027 — Kirstenbosch Tea Room, Rhodes Dr, Newlands');
    expect(multi.indexOf('Ceremony')).toBeLessThan(multi.indexOf('Kirstenbosch'));

    const single = await htmlFor(oneDayGuest.guestId);
    expect(single).toContain('<strong>Date:</strong> 6 June 2027');
    expect(single).toContain('<strong>Venue:</strong> Kirstenbosch Tea Room, Rhodes Dr, Newlands');
    expect(single).not.toContain('Your days:');

    for (const html of [multi, single]) {
      expect(html).not.toContain('RETIRED');
      expect(html).not.toContain('ARCHIVED VENUE');
    }
  }, 60000);
});
