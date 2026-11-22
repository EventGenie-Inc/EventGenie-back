import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import {
  createCapacityEvent,
  cleanupDayCapacityFixtures,
  inviteGuest,
  acceptedGuest,
  prisma,
  type CapacityEvent,
} from '../event-day/day-capacity-fixtures.js';

// ─────────────────────────────────────────
//  RSVP AND DAY CAPACITY — informational, never a refusal
//
//  A day's venue capacity never stops a guest accepting: a day over it
//  takes the answer, and the organiser sees a warning on the event detail.
//  Guests never see capacity. A "yes" to an invitation for a single day
//  attends that day even without day ids, so it counts.
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });
beforeEach(() => installFirebaseMock());
afterAll(cleanupDayCapacityFixtures, 120_000);

const detail = async (ev: CapacityEvent) => (await request(app).get(`/api/events/${ev.eventId}`).set(headersFor(ev.organiser))).body.data;
const attendingCounts = async (ev: CapacityEvent) =>
  Object.fromEntries((await detail(ev)).eventDays.map((d: { label: string; attendingCount: number }) => [d.label, d.attendingCount]));

describe('RSVP acceptance on a day at or over its capacity', () => {
  it('is accepted, and the organiser is warned; the guest’s response says nothing about capacity', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 1 }, { label: 'Sunday', capacity: 5 }]);
    const sat = ev.days['Saturday']!;
    await acceptedGuest(ev, [sat]); // Saturday full

    const { invite } = await inviteGuest(ev, [sat, ev.days['Sunday']!], 1);
    const res = await rsvpService.submit({ token: invite.token, attending: true, attendingDayIds: [sat], plusOneNames: ['Plus'] });
    expect(res.invite.status).toBe('ACCEPTED');
    expect(JSON.stringify(res)).not.toMatch(/"(capacity|isFull|attendingCount|capacityWarnings)":/);

    expect(await attendingCounts(ev)).toEqual({ Saturday: 3, Sunday: 0 });
    expect((await detail(ev)).capacityWarnings).toEqual([
      {
        eventDayId: sat,
        label: 'Saturday',
        capacity: 1,
        attending: 3,
        message: 'Saturday has 3 people attending, over its venue capacity of 1.',
      },
    ]);
  });

  it('a guest on a day over capacity can still change their answer and come back', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 1 }]);
    const sat = ev.days['Saturday']!;
    await acceptedGuest(ev, [sat]);
    const { invite } = await acceptedGuest(ev, [sat], 2);
    await rsvpService.submit({ token: invite.token, attending: false });
    const back = await rsvpService.submit({ token: invite.token, attending: true, attendingDayIds: [sat], plusOneNames: ['A', 'B'] });
    expect(back.invite.status).toBe('ACCEPTED');
    expect(await attendingCounts(ev)).toEqual({ Saturday: 4 });
  });
});

describe('a single-day invitation counts towards its day', () => {
  it('a "yes" with no day ids (left out, or empty) attends the one day, plus-ones too', async () => {
    const ev = await createCapacityEvent([{ label: 'Gala', capacity: 2 }]);
    const gala = ev.days['Gala']!;
    const a = await inviteGuest(ev, [gala], 1);
    const b = await inviteGuest(ev, [gala]);

    const res = await rsvpService.submit({ token: a.invite.token, attending: true, plusOneNames: ['Partner'] });
    expect(res.attendances.map((x) => x.eventDayId)).toEqual([gala, gala]);
    await rsvpService.submit({ token: b.invite.token, attending: true, attendingDayIds: [] });

    expect(await attendingCounts(ev)).toEqual({ Gala: 3 });
    expect((await detail(ev)).capacityWarnings.map((w: { message: string }) => w.message)).toEqual([
      'Gala has 3 people attending, over its venue capacity of 2.',
    ]);
  });

  it('an invitation to one day of a multi-day event is a single-day invitation too; with several days the guest’s choice stands', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday' }, { label: 'Sunday' }]);
    const one = await inviteGuest(ev, [ev.days['Sunday']!]);
    const both = await inviteGuest(ev, [ev.days['Saturday']!, ev.days['Sunday']!]);
    await rsvpService.submit({ token: one.invite.token, attending: true });
    await rsvpService.submit({ token: both.invite.token, attending: true });
    expect(await attendingCounts(ev)).toEqual({ Saturday: 0, Sunday: 1 });
  });

  it('a day removed after the invitation leaves nothing to default to', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday' }, { label: 'Sunday' }]);
    const { invite } = await inviteGuest(ev, [ev.days['Saturday']!, ev.days['Sunday']!]);
    await prisma.eventDay.update({ where: { id: ev.days['Saturday']! }, data: { isArchived: true } });
    // One live invited day left: that one.
    const res = await rsvpService.submit({ token: invite.token, attending: true });
    expect(res.attendances.map((x) => x.eventDayId)).toEqual([ev.days['Sunday']]);
  });
});

describe('the guest’s invitation never shows capacity', () => {
  it('has no isFull, capacity or counts on its days, whatever the day’s state', async () => {
    const ev = await createCapacityEvent([{ label: 'Saturday', capacity: 1 }]);
    await acceptedGuest(ev, [ev.days['Saturday']!], 1); // over capacity
    const { invite } = await inviteGuest(ev, [ev.days['Saturday']!]);
    const view = await rsvpService.validate(invite.token);
    expect(Object.keys(view.invite.inviteEventDay[0]!.eventDay).sort()).toEqual(
      ['address', 'date', 'endTime', 'id', 'label', 'latitude', 'location', 'locationType', 'longitude', 'onlineUrl', 'startTime'].sort()
    );
    expect(JSON.stringify(view)).not.toMatch(/"(capacity|isFull|attendingCount|capacityWarnings)":/);
  });
});
