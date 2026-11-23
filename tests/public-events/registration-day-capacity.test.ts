import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { clearSentEmails, sentEmails } from '../helpers/sent-emails.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, view, freshEmail, prisma, type PublicEventFixture } from './helpers.js';

// ─────────────────────────────────────────
//  PUBLIC REGISTRATION, ITS APPROVAL, AND DAY CAPACITY
//
//  Capacity is informational: registering for, and approving a
//  registration on, a day at or over its capacity goes through. The
//  organiser is warned (the event detail; the approval response, at the
//  moment they approve). The public page and the registrant never see
//  capacity. A single-day event's registration counts towards its day.
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});
afterEach(cleanupPublicEventFixtures, 120_000);

const asOrganiser = (ev: PublicEventFixture) => headersFor(ev.organiser);
const detail = async (ev: PublicEventFixture) => (await request(app).get(`/api/events/${ev.eventId}`).set(asOrganiser(ev))).body.data;
const counts = async (ev: PublicEventFixture) =>
  Object.fromEntries((await detail(ev)).eventDays.map((d: { label: string; attendingCount: number }) => [d.label, d.attendingCount]));
const approve = (ev: PublicEventFixture, guestId: string) =>
  request(app).post(`/api/events/${ev.eventId}/registrations/${guestId}/approve`).set(asOrganiser(ev));
const decline = (ev: PublicEventFixture, guestId: string) =>
  request(app).post(`/api/events/${ev.eventId}/registrations/${guestId}/decline`).set(asOrganiser(ev));
const guestId = async (eventId: string, email: string) => (await prisma.guest.findFirstOrThrow({ where: { eventId, email } })).id;

// A single-day public event (the fixture's one day, "Day 1") with this capacity.
const singleDay = async (capacity: number | null, event: Record<string, unknown> = {}) => {
  const ev = await createPublicEvent({ event: { registrationPlusOnesAllowed: 2, ...event } });
  await prisma.eventDay.update({ where: { id: ev.dayIds[0]! }, data: { capacity } });
  return ev;
};

describe('registering on a day at or over its capacity', () => {
  it('is accepted (201, the ordinary answer), and the organiser is warned', async () => {
    const ev = await singleDay(1);
    expect((await register(ev.shareToken, {})).status).toBe(201);
    const second = await register(ev.shareToken, { plusOneNames: ['Plus'] });
    expect(second.status).toBe(201);
    expect(JSON.stringify(second.body)).not.toMatch(/"(capacity|isFull|attendingCount|capacityWarnings)":/);

    const d = await detail(ev);
    expect(d.eventDays[0].attendingCount).toBe(3);
    expect(d.capacityWarnings.map((w: { message: string }) => w.message)).toEqual([
      'Day 1 has 3 people attending, over its venue capacity of 1.',
    ]);
  });

  it('the public page shows no capacity, no isFull, and stays open', async () => {
    const ev = await singleDay(1);
    await register(ev.shareToken, {});
    await register(ev.shareToken, {});
    const page = await view(ev.shareToken);
    expect(page.status).toBe(200);
    expect(page.body.data.registration.isOpen).toBe(true);
    expect(page.body.data.days[0]).not.toHaveProperty('isFull');
    expect(JSON.stringify(page.body)).not.toMatch(/"(capacity|isFull|attending|attendingCount|capacityWarnings)":/);
  });
});

describe('a single-day public event counts towards its day', () => {
  it('a registration without dayIds counts, plus-ones too', async () => {
    const ev = await singleDay(null);
    await register(ev.shareToken, { plusOneNames: ['A', 'B'] });
    expect(await counts(ev)).toEqual({ 'Day 1': 3 });
  });

  it('with approval: nothing counts while pending; approving counts the party', async () => {
    const ev = await singleDay(null, { registrationAutoApprove: false });
    const email = freshEmail();
    await register(ev.shareToken, { email, plusOneNames: ['A'] });
    expect(await counts(ev)).toEqual({ 'Day 1': 0 });
    expect((await approve(ev, await guestId(ev.eventId, email))).status).toBe(200);
    expect(await counts(ev)).toEqual({ 'Day 1': 2 });
  });
});

describe('approving a registration on a day it takes over capacity', () => {
  it('goes through, and the organiser’s response carries the warning; at capacity it is empty', async () => {
    const ev = await singleDay(2, { registrationAutoApprove: false });
    const first = freshEmail();
    const second = freshEmail();
    await register(ev.shareToken, { email: first, plusOneNames: ['A'] });
    await register(ev.shareToken, { email: second });

    const atCapacity = await approve(ev, await guestId(ev.eventId, first));
    expect(atCapacity.status).toBe(200);
    expect(atCapacity.body.data).toEqual({ guestId: expect.any(String), decision: 'APPROVED', emailSent: expect.any(Boolean), capacityWarnings: [] });

    const over = await approve(ev, await guestId(ev.eventId, second));
    expect(over.status).toBe(200);
    expect(over.body.data.decision).toBe('APPROVED');
    expect(over.body.data.capacityWarnings).toEqual([
      {
        eventDayId: ev.dayIds[0],
        label: 'Day 1',
        capacity: 2,
        attending: 3,
        message: 'Day 1 has 3 people attending, over its venue capacity of 2.',
      },
    ]);
    // The registrant hears nothing about capacity.
    const approvedEmail = sentEmails().filter((m) => m.to === second);
    expect(approvedEmail.length).toBeGreaterThan(0);
    expect(JSON.stringify(approvedEmail)).not.toMatch(/venue capacity|over its/i);
  });

  it('declining carries no warnings', async () => {
    const ev = await singleDay(1, { registrationAutoApprove: false });
    const email = freshEmail();
    await register(ev.shareToken, { email });
    const res = await decline(ev, await guestId(ev.eventId, email));
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('capacityWarnings');
  });
});
