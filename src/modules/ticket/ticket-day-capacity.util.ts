import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventDayRepository } from '../event-day/event-day.repository.js';
import { countTakenForCheckout, dayPlacesLeft } from '../event-day/day-capacity.util.js';
import { TICKET_ORDER_CODES } from '../ticket-order/ticket-order.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  TICKET SALES STOP AT A DAY'S CAPACITY (STEERING "Venue", "Ticket sales")
//
//  A buyer pays for a place, so they can't be sold one that doesn't exist.
//  Every day a ticket admits (every live day of its event, or the chosen
//  ones) with a capacity: sold + held + attending guests + this order's
//  tickets admitting it must stay within it (day-capacity.util.ts's
//  CHECKOUT count). A day with no capacity, and every online day (never
//  one), has no limit. Guests are never refused: they only make the day
//  fuller for ticket buyers. Tickets never count towards the plan's guest
//  limit.
//
//  ATOMIC: a checkout (and a retry) locks the days its order needs
//  (lockOrderDays, FOR UPDATE in id order) BEFORE the type holds, then
//  holds each type (its own quantity first: TICKET_ORDER_NOT_ENOUGH_LEFT),
//  then counts the days under the lock and refuses (assertOrderDaysHaveRoom,
//  409 TICKET_ORDER_DAY_FULL), all in one transaction. Every hold against
//  a day takes the same lock, so of two buyers racing for a day's last
//  place one gets it and the other waits, then counts the first's hold.
//  Freeing a place (cancelling, a refund, a hold expiring) needs no lock:
//  it only makes the count smaller.
//
//  A payment after its hold lapsed is honoured anyway (never refuse a paid
//  order); daysOverIfSold names the days it takes past capacity, and the
//  order is flagged oversold.
// ─────────────────────────────────────────

const TICKET_ORDER_DAY_FULL = TICKET_ORDER_CODES.DAY_FULL;

// What a ticket (a type, or an order item's snapshot) admits.
export interface AdmittingLine {
  admitsAllDays: boolean;
  admittedDayIds: string[];
  quantity: number;
}

const admitted = (line: Omit<AdmittingLine, 'quantity'>, liveDayIds: string[]): string[] =>
  line.admitsAllDays ? liveDayIds : line.admittedDayIds.filter((id) => liveDayIds.includes(id));

// How many of this order's tickets admit each live day.
const needByDay = (lines: AdmittingLine[], liveDayIds: string[]): Map<string, number> => {
  const need = new Map<string, number>();
  for (const line of lines) for (const id of admitted(line, liveDayIds)) need.set(id, (need.get(id) ?? 0) + line.quantity);
  return need;
};

export type LockedDay = { id: string; label: string; date: Date; capacity: number };

// Step 1, before any type is held: lock every day the order's tickets admit,
// and return those with a capacity (the only ones that can refuse).
export const lockOrderDays = (tx: Prisma.TransactionClient, lines: AdmittingLine[], liveDayIds: string[]): Promise<LockedDay[]> =>
  eventDayRepository.lockCappedDays(tx, [...needByDay(lines, liveDayIds).keys()]);

export interface DayShortfall {
  eventDayId: string;
  dayLabel: string;
  remaining: number;
}

export const dayFullMessage = (label: string, remaining: number): string =>
  remaining === 0
    ? `${label} is sold out.`
    : `Only ${remaining} ${remaining === 1 ? 'place is' : 'places are'} left on ${label}.`;

// Step 2, after the type holds, under step 1's lock: refuse when this order
// would take any day past its capacity. The order's own hold isn't written
// yet (or, on a retry, was given back), so the count never includes it.
// Several days short: the first by date is named, every one is in details.days.
export const assertOrderDaysHaveRoom = async (
  tx: Prisma.TransactionClient,
  lockedDays: LockedDay[],
  lines: AdmittingLine[],
  liveDayIds: string[],
  now: Date
): Promise<void> => {
  if (lockedDays.length === 0) return;
  const need = needByDay(lines, liveDayIds);
  const taken = await countTakenForCheckout(lockedDays.map((d) => d.id), tx, now);
  const short = lockedDays
    .filter((d) => (taken.get(d.id) ?? 0) + (need.get(d.id) ?? 0) > d.capacity)
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id))
    .map((d): DayShortfall => ({ eventDayId: d.id, dayLabel: d.label, remaining: dayPlacesLeft(d.capacity, taken.get(d.id) ?? 0) }));
  const first = short[0];
  if (!first) return;
  throw new HttpError(409, dayFullMessage(first.dayLabel, first.remaining), TICKET_ORDER_DAY_FULL, { ...first, days: short });
};

// Places left for ticket sales on each of these days that has a capacity
// (CHECKOUT count). Days with no capacity (and online days) are left out:
// no limit. For the public page's effective remaining.
export const placesLeftByDay = async (eventDayIds: string[], db: Db = prisma, now: Date = new Date()): Promise<Map<string, number>> => {
  const days = await eventDayRepository.findCappedDays([...new Set(eventDayIds)], db);
  if (days.length === 0) return new Map();
  const taken = await countTakenForCheckout(days.map((d) => d.id), db, now);
  return new Map(days.map((d) => [d.id, dayPlacesLeft(d.capacity!, taken.get(d.id) ?? 0)]));
};

// The lowest of a type's own remaining (null = unlimited) and the places
// left on each day it admits. null when neither limits it.
export const effectiveRemaining = (
  ownRemaining: number | null,
  type: { admitsAllDays: boolean; admittedDayIds: string[] },
  liveDayIds: string[],
  placesLeft: Map<string, number>
): number | null => {
  let lowest = ownRemaining;
  for (const id of admitted(type, liveDayIds)) {
    const left = placesLeft.get(id);
    if (left !== undefined && (lowest === null || left < lowest)) lowest = left;
  }
  return lowest;
};

// A late payment (its hold lapsed): the days this order's tickets take past
// their capacity, if sold now. Read before its tickets are issued, so the
// count doesn't include them; no lock (it is only a flag: the order is sold
// whatever this says).
export const daysOverIfSold = async (tx: Prisma.TransactionClient, eventId: string, lines: AdmittingLine[], now: Date): Promise<string[]> => {
  const liveDayIds = (await tx.eventDay.findMany({ where: { eventId, isArchived: false }, select: { id: true } })).map((d) => d.id);
  const need = needByDay(lines, liveDayIds);
  const days = await eventDayRepository.findCappedDays([...need.keys()], tx);
  if (days.length === 0) return [];
  const taken = await countTakenForCheckout(days.map((d) => d.id), tx, now);
  return days.filter((d) => (taken.get(d.id) ?? 0) + (need.get(d.id) ?? 0) > d.capacity!).map((d) => d.label);
};
