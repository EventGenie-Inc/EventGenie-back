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
//  if the answer names no day (rsvp.service.ts's submit). Valid, sold
//  tickets admitting the day count too, and for ticket sales so do tickets
//  held by checkouts in progress (the two modes below).
//
//  TICKETS ARE THE EXCEPTION TO "never blocks": a buyer pays for a place,
//  so ticket sales stop when a day is full (ticket-day-capacity.util.ts,
//  checkout and retry). Guests are still never refused. A payment arriving
//  after its hold expired is honoured anyway and flagged oversold.
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

// ── The one count, in two modes ──
//
//  ATTENDING (countAttendingForDays): attending guests (WHO COUNTS above)
//  plus valid, sold tickets admitting the day. What organisers see:
//  attendingCount and every capacity warning.
//  CHECKOUT (countTakenForCheckout): the same, plus tickets held by
//  checkouts in progress (a hold still standing: not released, not
//  expired). What ticket sales stop at: checkout, retry, the public
//  "sold out" and "only N left", the sales summary's remaining.
//  Both read the same queries (countDayBreakdown); only `held` differs.
//  Cancelled, refunded and reversed tickets, and expired holds, never count.

export type DayCountMode = 'ATTENDING' | 'CHECKOUT';

export interface DayCountBreakdown {
  guests: number;
  sold: number;
  // Always 0 in ATTENDING mode.
  held: number;
  total: number;
}

export const countDayBreakdown = async (
  eventDayIds: string[],
  mode: DayCountMode,
  db: Db = prisma,
  now: Date = new Date()
): Promise<Map<string, DayCountBreakdown>> => {
  const ids = [...new Set(eventDayIds)];
  const result = new Map<string, DayCountBreakdown>();
  if (ids.length === 0) return result;
  const guests = await eventDayRepository.countAttendingByDay(ids, db);
  const tickets = await eventDayRepository.countTicketsByDay(ids, mode === 'CHECKOUT' ? now : null, db);
  for (const id of ids) {
    const g = guests.get(id) ?? 0;
    const t = tickets.get(id) ?? { sold: 0, held: 0 };
    const held = mode === 'CHECKOUT' ? t.held : 0;
    result.set(id, { guests: g, sold: t.sold, held, total: g + t.sold + held });
  }
  return result;
};

const totals = (breakdown: Map<string, DayCountBreakdown>): Map<string, number> =>
  new Map([...breakdown].filter(([, c]) => c.total > 0).map(([id, c]) => [id, c.total]));

// How many people attend each day: guests and sold tickets (ATTENDING).
// Days nobody attends are left out of the map.
export const countAttendingForDays = async (eventDayIds: string[], db: Db = prisma): Promise<Map<string, number>> =>
  totals(await countDayBreakdown(eventDayIds, 'ATTENDING', db));

// How many places each day has taken, for selling tickets: guests, sold
// tickets and tickets held by checkouts in progress (CHECKOUT). Days with
// nothing taken are left out of the map.
export const countTakenForCheckout = async (eventDayIds: string[], db: Db = prisma, now: Date = new Date()): Promise<Map<string, number>> =>
  totals(await countDayBreakdown(eventDayIds, 'CHECKOUT', db, now));

// What's left of a day's capacity for ticket sales: never below 0.
export const dayPlacesLeft = (capacity: number, taken: number): number => Math.max(0, capacity - taken);

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

// ── Warnings: ticket types for a day adding up to more than its capacity ──
//
// The ticket types list (organisers only). Only a warning: saving a type is
// never refused for it, and sales stop at the day's capacity anyway. Counts
// the ACTIVE types admitting the day (every day, or chosen ones); a legacy
// type with no quantity (unlimited, before 2026-11) is left out of the sum.

export interface TicketQuantityWarning {
  eventDayId: string;
  label: string;
  capacity: number;
  ticketQuantity: number;
  message: string;
}

export const ticketQuantityWarningMessage = (label: string, quantity: number, capacity: number): string =>
  `Your ticket types for ${label} add up to ${quantity}, but the venue holds ${capacity}. Ticket sales stop at ${capacity}.`;

export const ticketQuantityWarnings = (
  days: { id: string; label: string; capacity: number | null }[],
  types: { status: string; isArchived: boolean; totalQuantity: number | null; admitsAllDays: boolean; admittedDayIds: string[] }[]
): TicketQuantityWarning[] =>
  days.flatMap((d) => {
    if (d.capacity === null) return [];
    const quantity = types
      .filter((t) => t.status === 'ACTIVE' && !t.isArchived && t.totalQuantity !== null && (t.admitsAllDays || t.admittedDayIds.includes(d.id)))
      .reduce((sum, t) => sum + (t.totalQuantity ?? 0), 0);
    return quantity > d.capacity
      ? [{ eventDayId: d.id, label: d.label, capacity: d.capacity, ticketQuantity: quantity, message: ticketQuantityWarningMessage(d.label, quantity, d.capacity) }]
      : [];
  });

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
