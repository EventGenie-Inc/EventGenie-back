import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import {
  createCapacityEvent,
  cleanupDayCapacityFixtures,
  acceptedGuest,
  attendanceRows,
  prisma,
  type CapacityEvent,
} from './day-capacity-fixtures.js';

// ─────────────────────────────────────────
//  VENUE CAPACITY PER DAY — the organiser's side
//
//  Set wherever days are created or edited (POST/PUT .../days, the wizard,
//  the full update) and returned on each day; refused on an online day. An
//  event-level capacity with no day capacities (an older frontend) goes to
//  every venue day, with a deprecation warning in the log. Lowering a day
//  below the number attending is saved with a warning; nobody is removed.
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });

beforeEach(() => installFirebaseMock());
afterEach(() => vi.restoreAllMocks());
afterAll(cleanupDayCapacityFixtures, 120_000);

const as = (ev: CapacityEvent) => headersFor(ev.organiser);
const capacityOf = async (dayId: string) => (await prisma.eventDay.findUniqueOrThrow({ where: { id: dayId } })).capacity;

describe('a day’s capacity', () => {
  it('is set on POST and PUT .../days and returned on each day', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday' }]);
    const created = await request(app)
      .post(`/api/events/${ev.eventId}/days`)
      .set(as(ev))
      .send({ label: 'Sunday', date: '2030-03-03', location: 'Garden', address: '2 Road', capacity: 80 });
    expect(created.status).toBe(201);
    expect(created.body.data.capacity).toBe(80);

    const updated = await request(app).put(`/api/events/${ev.eventId}/days/${created.body.data.id}`).set(as(ev)).send({ capacity: 120 });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ capacity: 120, capacityWarnings: [] });

    // Left out: kept. null: no limit.
    await request(app).put(`/api/events/${ev.eventId}/days/${created.body.data.id}`).set(as(ev)).send({ label: 'Sunday brunch' });
    expect(await capacityOf(created.body.data.id)).toBe(120);
    await request(app).put(`/api/events/${ev.eventId}/days/${created.body.data.id}`).set(as(ev)).send({ capacity: null });
    expect(await capacityOf(created.body.data.id)).toBeNull();

    const list = await request(app).get(`/api/events/${ev.eventId}/days`).set(as(ev));
    expect(list.body.data.map((d: { capacity: number | null }) => d.capacity)).toEqual([null, null]);
  });

  it('is refused on an online day (422 EVENT_DAY_CAPACITY_ONLINE), and an out-of-range one names the day', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 50 }]);
    const online = await request(app)
      .post(`/api/events/${ev.eventId}/days`)
      .set(as(ev))
      .send({ label: 'Stream', date: '2030-03-03', locationType: 'ONLINE', capacity: 100 });
    expect(online.status).toBe(422);
    expect(online.body).toEqual({
      status: 'error',
      message: "'Stream' happens online, so it has no venue capacity. Remove the capacity, or set it on a venue day.",
      code: 'EVENT_DAY_CAPACITY_ONLINE',
    });

    // Switching a venue day to online with a capacity: refused. Without one:
    // the day loses the capacity it had.
    const toOnline = await request(app)
      .put(`/api/events/${ev.eventId}/days/${ev.days['Saturday']}`)
      .set(as(ev))
      .send({ locationType: 'ONLINE', capacity: 50 });
    expect(toOnline.status).toBe(422);
    expect(toOnline.body.code).toBe('EVENT_DAY_CAPACITY_ONLINE');
    expect(await capacityOf(ev.days['Saturday']!)).toBe(50);
    const switched = await request(app).put(`/api/events/${ev.eventId}/days/${ev.days['Saturday']}`).set(as(ev)).send({ locationType: 'ONLINE' });
    expect(switched.status).toBe(200);
    expect(await capacityOf(ev.days['Saturday']!)).toBeNull();

    const bad = await request(app)
      .post(`/api/events/${ev.eventId}/days`)
      .set(as(ev))
      .send({ label: 'Hall day', date: '2030-03-04', location: 'Hall', address: '1 Road', capacity: 0 });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({
      status: 'error',
      message: "The venue capacity for 'Hall day' must be a whole number from 1 to 100,000.",
      code: 'EVENT_CAPACITY_INVALID',
    });
  });

  it('the full update sets each day’s own capacity, and refuses one on an online day', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 10 }, { label: 'Stream', online: true }]);
    const res = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(as(ev))
      .send({
        days: [
          { id: ev.days['Saturday'], capacity: 25 },
          { id: ev.days['Stream'] },
          { label: 'Sunday', date: '2030-03-05', location: 'Garden', address: '3 Road', capacity: 40 },
        ],
      });
    expect(res.status).toBe(200);
    const byLabel = Object.fromEntries(res.body.data.eventDays.map((d: { label: string; capacity: number | null }) => [d.label, d.capacity]));
    expect(byLabel).toEqual({ Saturday: 25, Stream: null, Sunday: 40 });
    expect(res.body.data.capacityWarnings).toEqual([]);

    const refused = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(as(ev))
      .send({ days: [{ id: ev.days['Saturday'] }, { id: ev.days['Stream'], capacity: 5 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('EVENT_DAY_CAPACITY_ONLINE');
  });

  it('the event detail gives each day how many people attend it', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 100 }, { label: 'Sunday' }]);
    await acceptedGuest(ev, [ev.days['Saturday']!, ev.days['Sunday']!], 2);
    await acceptedGuest(ev, [ev.days['Sunday']!]);
    const res = await request(app).get(`/api/events/${ev.eventId}`).set(as(ev));
    expect(res.status).toBe(200);
    const days = Object.fromEntries(
      res.body.data.eventDays.map((d: { label: string; capacity: number | null; attendingCount: number }) => [d.label, [d.capacity, d.attendingCount]])
    );
    expect(days).toEqual({ Saturday: [100, 3], Sunday: [null, 4] });
    // Event-wide, unchanged: every accepted guest and plus-one.
    expect(res.body.data.acceptedGuestCount).toBe(4);
  });
});

describe('compatibility: an event-level capacity from an older frontend', () => {
  it('PUT /api/events/:id applies it to every venue day (online days keep none) and logs a deprecation without personal data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 10 }, { label: 'Sunday' }, { label: 'Stream', online: true }]);
    const res = await request(app).put(`/api/events/${ev.eventId}`).set(as(ev)).send({ capacity: 75 });
    expect(res.status).toBe(200);
    expect(res.body.data.capacityWarnings).toEqual([]);
    expect([await capacityOf(ev.days['Saturday']!), await capacityOf(ev.days['Sunday']!), await capacityOf(ev.days['Stream']!)]).toEqual([75, 75, null]);

    const logged = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[day capacity]'));
    expect(logged).toEqual([
      `[day capacity] deprecated: PUT /api/events/:id sent the event-level capacity for event ${ev.eventId}; applied to every venue day. Send capacity on each day instead.`,
    ]);
    expect(logged[0]).not.toMatch(/@|Test Host|Organiser/);

    // null clears every venue day.
    await request(app).put(`/api/events/${ev.eventId}`).set(as(ev)).send({ capacity: null });
    expect([await capacityOf(ev.days['Saturday']!), await capacityOf(ev.days['Sunday']!)]).toEqual([null, null]);
  });

  it('the full update: with days and none of them carrying a capacity, every venue day takes it; with no days, the saved venue days do', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ev = await createCapacityEvent([{ label: 'Saturday' }, { label: 'Stream', online: true }]);
    const withDays = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(as(ev))
      .send({
        event: { capacity: 60 },
        days: [{ id: ev.days['Saturday'] }, { id: ev.days['Stream'] }, { label: 'Sunday', date: '2030-03-05', location: 'Garden', address: '3 Road' }],
      });
    expect(withDays.status).toBe(200);
    expect(Object.fromEntries(withDays.body.data.eventDays.map((d: { label: string; capacity: number | null }) => [d.label, d.capacity]))).toEqual({
      Saturday: 60,
      Stream: null,
      Sunday: 60,
    });

    const noDays = await request(app).put(`/api/events/${ev.eventId}/full`).set(as(ev)).send({ event: { capacity: 30 } });
    expect(noDays.status).toBe(200);
    expect(Object.fromEntries(noDays.body.data.eventDays.map((d: { label: string; capacity: number | null }) => [d.label, d.capacity]))).toEqual({
      Saturday: 30,
      Stream: null,
      Sunday: 30,
    });
  });

  it('the full update: a day capacity in the request wins, and the event-level one is not applied', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday' }, { label: 'Sunday' }]);
    const res = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(as(ev))
      .send({ event: { capacity: 500 }, days: [{ id: ev.days['Saturday'], capacity: 20 }, { id: ev.days['Sunday'] }] });
    expect(res.status).toBe(200);
    expect([await capacityOf(ev.days['Saturday']!), await capacityOf(ev.days['Sunday']!)]).toEqual([20, null]);
  });

  it('the wizard: a draft with an event-level capacity and none on its days gives every venue day that number', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ev = await createCapacityEvent([{ label: 'Unused' }]);
    const tenantId = ev.organiser.tenantId!;
    await eventDraftRepository.upsert(tenantId, ev.organiser.id, {
      currentStep: 4,
      payload: {
        name: 'Wizard capacity',
        hostName: 'Test Host',
        capacity: 150,
        days: [
          { label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Road' },
          { label: 'Day 2', date: '2030-03-03T00:00:00', locationType: 'ONLINE' },
        ],
      },
    });
    const event = await eventDraftService.materialize(tenantId, ev.organiser.id);
    const days = await prisma.eventDay.findMany({ where: { eventId: event!.id }, orderBy: { date: 'asc' } });
    expect(days.map((d) => d.capacity)).toEqual([150, null]);

    // A draft that sets day capacities keeps them.
    await eventDraftRepository.upsert(tenantId, ev.organiser.id, {
      currentStep: 4,
      payload: {
        name: 'Wizard day capacity',
        hostName: 'Test Host',
        days: [
          { label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Road', capacity: 30 },
          { label: 'Day 2', date: '2030-03-03T00:00:00', location: 'Garden', address: '2 Road' },
        ],
      },
    });
    const second = await eventDraftService.materialize(tenantId, ev.organiser.id);
    expect((await prisma.eventDay.findMany({ where: { eventId: second!.id }, orderBy: { date: 'asc' } })).map((d) => d.capacity)).toEqual([30, null]);
  });
});

describe('the organiser’s capacity warnings', () => {
  it('the event detail warns for every day over its capacity, and is silent at or under it', async () => {
    const ev = await createCapacityEvent([
      { label: 'Friday', capacity: 2 }, // 3 attending: over
      { label: 'Saturday', capacity: 3 }, // 3: at
      { label: 'Sunday', capacity: 10 }, // 1: under
      { label: 'Monday' }, // no capacity
    ]);
    await acceptedGuest(ev, [ev.days['Friday']!, ev.days['Saturday']!, ev.days['Monday']!], 2);
    await acceptedGuest(ev, [ev.days['Sunday']!]);

    const res = await request(app).get(`/api/events/${ev.eventId}`).set(as(ev));
    expect(res.status).toBe(200);
    expect(res.body.data.capacityWarnings).toEqual([
      { eventDayId: ev.days['Friday'], label: 'Friday', capacity: 2, attending: 3, message: 'Friday has 3 people attending, over its venue capacity of 2.' },
    ]);

    const quiet = await createCapacityEvent([{ label: 'Gala', capacity: 1 }]);
    await acceptedGuest(quiet, [quiet.days['Gala']!]);
    const one = await request(app).get(`/api/events/${quiet.eventId}`).set(as(quiet));
    expect(one.body.data.capacityWarnings).toEqual([]);
    await prisma.eventDay.update({ where: { id: quiet.days['Gala']! }, data: { capacity: null } });
    expect((await request(app).get(`/api/events/${quiet.eventId}`).set(as(quiet))).body.data.capacityWarnings).toEqual([]);
  });

  it('lowering a day below the number attending is saved with the warning; nobody is removed and guests can still accept', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 10 }]);
    const sat = ev.days['Saturday']!;
    await acceptedGuest(ev, [sat], 2); // 3 people on Saturday
    await acceptedGuest(ev, [sat]); // 4
    const rowsBefore = await attendanceRows(sat);

    const res = await request(app).put(`/api/events/${ev.eventId}/days/${sat}`).set(as(ev)).send({ capacity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data.capacity).toBe(2);
    expect(res.body.data.capacityWarnings).toEqual([
      { eventDayId: sat, label: 'Saturday', capacity: 2, attending: 4, message: 'Saturday has 4 people attending, over its venue capacity of 2.' },
    ]);
    expect(await attendanceRows(sat)).toBe(rowsBefore);

    // A new guest still accepts Saturday; the day is now 5 of 2.
    await acceptedGuest(ev, [sat]);
    const detail = await request(app).get(`/api/events/${ev.eventId}`).set(as(ev));
    expect(detail.body.data.capacityWarnings.map((w: { message: string }) => w.message)).toEqual([
      'Saturday has 5 people attending, over its venue capacity of 2.',
    ]);
  });

  it('the full update (as the event detail does) and the legacy event capacity warn', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 10 }, { label: 'Sunday' }]);
    await acceptedGuest(ev, [ev.days['Saturday']!]);
    await acceptedGuest(ev, [ev.days['Saturday']!]);

    const full = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(as(ev))
      .send({ days: [{ id: ev.days['Saturday'], capacity: 1 }, { id: ev.days['Sunday'] }] });
    expect(full.status).toBe(200);
    expect(full.body.data.capacityWarnings.map((w: { message: string }) => w.message)).toEqual([
      'Saturday has 2 people attending, over its venue capacity of 1.',
    ]);

    const legacy = await request(app).put(`/api/events/${ev.eventId}`).set(as(ev)).send({ capacity: 1 });
    // Saturday is already 1, so only Sunday changed (nobody attends it): no warning.
    expect(legacy.body.data.capacityWarnings).toEqual([]);
    const legacyAgain = await request(app).put(`/api/events/${ev.eventId}`).set(as(ev)).send({ capacity: 3 });
    expect(legacyAgain.body.data.capacityWarnings).toEqual([]);
    const legacyLower = await request(app).put(`/api/events/${ev.eventId}`).set(as(ev)).send({ capacity: 1 });
    expect(legacyLower.body.data.capacityWarnings.map((w: { label: string; attending: number }) => [w.label, w.attending])).toEqual([['Saturday', 2]]);
  });
});
