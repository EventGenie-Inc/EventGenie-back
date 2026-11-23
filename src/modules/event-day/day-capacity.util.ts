import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { eventDayRepository } from './event-day.repository.js';
import { type DayVenue } from './event-day-venue.util.js';

// ─────────────────────────────────────────
//  VENUE CAPACITY PER EVENT DAY — informational, it never blocks a guest
//
//  Each day has its own venue, so each day has its own capacity
//  (EventDay.capacity, null = no limit, always null on an ONLINE day;
//  event-day-venue.util.ts validates it). It helps the organiser manage
//  their event: nothing a guest does (RSVP, registration) and nothing an
//  organiser approves is ever refused because of it, and guests never see
//  it. Event.capacity is deprecated and never read.
//
//  WHO COUNTS on a day (countAttendingForDays, the one count): an
//  Attendance row for that day whose invite is live and ACCEPTED and whose
//  guest isn't awaiting approval. A plus-one is its own Guest+Invite pair
//  with its own Attendance rows for the host's days, so a guest and their
//  plus-ones count one each. It is exactly the rule acceptedGuestCount has
//  always used for the event (eventRepository.countAcceptedInvitesForEvent),
//  applied per day. A registration awaiting approval counts once approved.
//  A guest who accepts an invitation to a single day attends that day even
//  if the answer names no day (rsvp.service.ts's submit). The ticket-sales
//  follow-up (dev) decides whether tickets admitting a day count here.
//
//  WARNINGS, for organisers only (capacityWarningsFor / warningsFromCounts):
//  a day where more people attend than its capacity. On the event detail
//  (every such day), on a save that changes a day's capacity (the changed
//  days), and on approving a registration (the registrant's days).
//
//  COMPATIBILITY until the frontend sends day capacities: a request that
//  sends the event-level `capacity` and no day capacity has it applied to
//  every venue day (applyLegacyCapacity / legacy writes in event.service.ts),
//  with a deprecation warning in the log (no personal data).
// ─────────────────────────────────────────

type Db = Prisma.TransactionClient | typeof prisma;

// How many people attend each day (see WHO COUNTS). Days nobody attends
// are left out of the map.
export const countAttendingForDays = (eventDayIds: string[], db: Db = prisma): Promise<Map<string, number>> =>
  eventDayRepository.countAttendingByDay(eventDayIds, db);

// ── Warnings: a day over its capacity ──

export interface CapacityWarning {
  eventDayId: string;
  label: string;
  capacity: number;
  attending: number;
  message: string;
}

export const capacityWarningMessage = (label: string, attending: number, capacity: number): string =>
  `${label} has ${attending} ${attending === 1 ? 'person' : 'people'} attending, over its venue capacity of ${capacity}.`;

// From days already loaded and their counts (the event detail has both).
// At or under capacity, or no capacity: no warning.
export const warningsFromCounts = (
  days: { id: string; label: string; capacity: number | null }[],
  attendingByDay: Map<string, number>
): CapacityWarning[] =>
  days.flatMap((d) => {
    const attending = attendingByDay.get(d.id) ?? 0;
    return d.capacity !== null && attending > d.capacity
      ? [{ eventDayId: d.id, label: d.label, capacity: d.capacity, attending, message: capacityWarningMessage(d.label, attending, d.capacity) }]
      : [];
  });

// The live days among these that have a capacity and more people
// attending than it.
export const capacityWarningsFor = async (eventDayIds: string[], db: Db = prisma): Promise<CapacityWarning[]> => {
  const days = await eventDayRepository.findCappedDays([...new Set(eventDayIds)], db);
  if (days.length === 0) return [];
  return warningsFromCounts(days, await countAttendingForDays(days.map((d) => d.id), db));
};

// ── Compatibility: an event-level capacity from an older frontend ──

// True when the request still uses the event-level field: it sends
// `capacity` on the event and no capacity on any day.
export const usesLegacyCapacity = (eventCapacity: unknown, days: { capacity?: unknown }[] | undefined): boolean =>
  eventCapacity !== undefined && !(days ?? []).some((d) => d.capacity !== undefined);

// Every venue day takes the event-level number; online days keep none.
export const applyLegacyCapacity = (venue: DayVenue, capacity: number | null): DayVenue =>
  venue.locationType === 'VENUE' ? { ...venue, capacity } : venue;

// No personal data: the route and the event id (when there is one) only.
export const logLegacyCapacity = (route: string, eventId?: string): void => {
  console.warn(
    `[day capacity] deprecated: ${route} sent the event-level capacity${eventId ? ` for event ${eventId}` : ''}; ` +
      'applied to every venue day. Send capacity on each day instead.'
  );
};
