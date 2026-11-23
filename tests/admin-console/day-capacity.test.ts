import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { createActor, headersFor, installFirebaseMock, type Actor } from '../helpers/team.js';
import { acceptedGuest } from '../event-day/day-capacity-fixtures.js';
import { cleanupTicketSalesFixtures } from '../ticket-sales/helpers.js';
import { buyAndPay, checkout, sellingEvent, prisma } from '../ticket-sales/orders-helpers.js';

// ─────────────────────────────────────────
//  THE SUPER ADMIN'S EVENT VIEW: CAPACITY PER DAY (STEERING "Super admin
//  console", "Venue")
//
//  Each day carries its capacity (null on an online day) and attendingCount:
//  the organiser's ATTENDING count (accepted guests plus sold tickets, never
//  checkout holds). Nothing about who those people are.
//
//  The fixture (sellingEvent): Day 1 and Day 2, 'General' (every day) and
//  'Saturday' (Day 2 only). Day 1 is a venue for 10; Day 2 goes online.
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });

let superAdmin: Actor;

beforeAll(async () => {
  superAdmin = await createActor('SUPER_ADMIN', null);
}, 120_000);

beforeEach(() => installFirebaseMock());

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTicketSalesFixtures();
}, 120_000);

afterAll(async () => {
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await prisma.otpRecord.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
}, 120_000);

describe('GET /api/admin/events/:eventId — days', () => {
  it('each day has its capacity and attendingCount (guests plus sold tickets); an online day’s capacity is null', async () => {
    const s = await sellingEvent();
    const [day1, day2] = [s.ev.dayIds[0]!, s.ev.dayIds[1]!];
    await prisma.eventDay.update({ where: { id: day1 }, data: { capacity: 10 } });
    await prisma.eventDay.update({ where: { id: day2 }, data: { locationType: 'ONLINE', location: null, address: null, onlineUrl: 'https://meet.test/x', capacity: null } });

    // Day 1: 2 guests + 3 sold. Day 2: 1 guest + 3 sold (General) + 1 sold (Saturday).
    const org = { tenantId: s.org.tenantId, organiser: s.org.admin, eventId: s.ev.eventId, days: {} };
    await acceptedGuest(org, [day1]);
    await acceptedGuest(org, [day1, day2]);
    await buyAndPay(s, [{ ticketTypeId: s.general, quantity: 3 }]);
    await buyAndPay(s, [{ ticketTypeId: s.saturday, quantity: 1 }]);
    // A checkout in progress holds places, but nobody attends on it yet.
    expect((await checkout(s, [{ ticketTypeId: s.general, quantity: 2 }])).status).toBe(201);

    const res = await request(app).get(`/api/admin/events/${s.ev.eventId}`).set(headersFor(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.data.days).toEqual([
      {
        id: day1,
        label: 'Day 1',
        date: '2027-03-01T00:00:00.000Z',
        startTime: null,
        endTime: null,
        locationType: 'VENUE',
        location: 'Venue 1',
        address: '1 Test Road',
        onlineUrl: null,
        capacity: 10,
        attendingCount: 5,
      },
      {
        id: day2,
        label: 'Day 2',
        date: '2027-03-02T00:00:00.000Z',
        startTime: null,
        endTime: null,
        locationType: 'ONLINE',
        location: null,
        address: null,
        onlineUrl: 'https://meet.test/x',
        capacity: null,
        attendingCount: 5,
      },
    ]);

    // The organiser's own event detail says the same.
    const organiserView = await request(app).get(`/api/events/${s.ev.eventId}`).set(headersFor(s.org.admin));
    expect(organiserView.body.data.eventDays.map((d: { attendingCount: number }) => d.attendingCount)).toEqual([5, 5]);
  });

  it('a day nobody attends has attendingCount 0', async () => {
    const s = await sellingEvent();
    const res = await request(app).get(`/api/admin/events/${s.ev.eventId}`).set(headersFor(superAdmin));
    expect(res.body.data.days.map((d: { capacity: number | null; attendingCount: number }) => [d.capacity, d.attendingCount])).toEqual([
      [null, 0],
      [null, 0],
    ]);
  });
});
