import { Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { withPlainDayCoordinates } from '../event/event-coordinates.util.js';
import { type DayVenue } from './event-day-venue.util.js';

// Values are validated and normalised by event-day.service.ts before they
// get here (label trimmed, date parsed, venue resolved) — this file only
// writes them. Every returned row goes through withPlainDayCoordinates:
// the venue's latitude/longitude are Decimal columns.
export interface EventDayWrite {
  label: string;
  date: Date;
  startTime: Date | null;
  endTime: Date | null;
  venue: DayVenue;
}

export interface EventDayPatch {
  label?: string;
  date?: Date;
  startTime?: Date | null;
  endTime?: Date | null;
  venue: DayVenue;
}

// Writes take an optional transaction client, so the full event update
// (event-full-update.service.ts) can apply every day in one transaction.
type Db = Prisma.TransactionClient | typeof prisma;

export const eventDayRepository = {
  findAll: async (eventId: string) =>
    (
      await prisma.eventDay.findMany({
        where: { eventId, isArchived: false },
        orderBy: { date: 'asc' },
      })
    ).map(withPlainDayCoordinates),

  findById: async (id: string) => {
    const day = await prisma.eventDay.findFirst({ where: { id, isArchived: false } });
    return day ? withPlainDayCoordinates(day) : null;
  },

  create: (eventId: string, userId: string, data: EventDayWrite, db: Db = prisma) =>
    db.eventDay
      .create({
        data: {
          eventId,
          label: data.label,
          date: data.date,
          startTime: data.startTime,
          endTime: data.endTime,
          location: data.venue.location,
          address: data.venue.address,
          latitude: data.venue.latitude,
          longitude: data.venue.longitude,
          locationType: data.venue.locationType,
          onlineUrl: data.venue.onlineUrl,
          capacity: data.venue.capacity,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      })
      .then(withPlainDayCoordinates),

  // The venue is always written in full: the service has already merged
  // the request with the stored day (event-day-venue.util.ts), including
  // clearing coordinates when the address changed without new ones.
  update: (id: string, userId: string, data: EventDayPatch, db: Db = prisma) =>
    db.eventDay
      .update({
        where: { id },
        data: {
          ...(data.label !== undefined && { label: data.label }),
          ...(data.date !== undefined && { date: data.date }),
          ...(data.startTime !== undefined && { startTime: data.startTime }),
          ...(data.endTime !== undefined && { endTime: data.endTime }),
          location: data.venue.location,
          address: data.venue.address,
          latitude: data.venue.latitude,
          longitude: data.venue.longitude,
          locationType: data.venue.locationType,
          onlineUrl: data.venue.onlineUrl,
          capacity: data.venue.capacity,
          updatedBy: userId,
        },
      })
      .then(withPlainDayCoordinates),

  archive: (id: string, userId: string, db: Db = prisma) =>
    db.eventDay.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),

  // How many people attend each of these days: day-capacity.util.ts's rule
  // (countAttendingForDays), the per-day form of
  // eventRepository.countAcceptedInvitesForEvent. One Attendance row per
  // person per day: a guest's own, and one per plus-one (each its own
  // Guest+Invite pair, rsvp.service.ts). Days with nobody are left out.
  countAttendingByDay: async (eventDayIds: string[], db: Db = prisma): Promise<Map<string, number>> => {
    if (eventDayIds.length === 0) return new Map();
    const rows = await db.attendance.groupBy({
      by: ['eventDayId'],
      where: {
        eventDayId: { in: eventDayIds },
        invite: { isArchived: false, status: 'ACCEPTED', guest: { pendingApproval: false } },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.eventDayId, r._count._all]));
  },

  // Tickets admitting each of these days (day-capacity.util.ts's
  // countDayBreakdown): `sold`, the VALID tickets of a confirmed order (PAID,
  // or a chargeback still open: check-in's rule for a ticket that admits
  // someone); `held`, only when `heldAt` is given, the tickets held by
  // checkouts whose hold is still standing at that instant (not released,
  // not expired). A ticket admits a day by its order item's snapshot, as at
  // the door (ticket-check-in.ts's ticketAdmitsDay): every day of its event,
  // or the chosen ones. Cancelled, refunded and reversed tickets never count.
  // One statement for both, so the two modes can't drift apart.
  countTicketsByDay: async (
    eventDayIds: string[],
    heldAt: Date | null,
    db: Db = prisma
  ): Promise<Map<string, { sold: number; held: number }>> => {
    if (eventDayIds.length === 0) return new Map();
    const withHeld = heldAt !== null;
    const at = heldAt ?? new Date(0);
    const rows = await db.$queryRaw<{ eventDayId: string; sold: number; held: number }[]>`
      SELECT d."id" AS "eventDayId",
        (SELECT COUNT(*)::int
           FROM "IssuedTicket" it
           JOIN "TicketOrder" o ON o."id" = it."orderId"
           JOIN "TicketOrderItem" oi ON oi."id" = it."orderItemId"
          WHERE it."eventId" = d."eventId"
            AND it."status" = 'VALID'
            AND (o."status" = 'PAID' OR (o."status" = 'UNDER_REVIEW' AND o."reviewReason" = 'DISPUTE'))
            AND (oi."admitsAllDays" OR d."id" = ANY(oi."admittedDayIds"))) AS "sold",
        (SELECT COALESCE(SUM(oi."quantity"), 0)::int
           FROM "TicketOrder" o
           JOIN "TicketOrderItem" oi ON oi."orderId" = o."id"
          WHERE ${withHeld}
            AND o."eventId" = d."eventId"
            AND o."status" IN ('PENDING', 'FAILED')
            AND o."holdReleasedAt" IS NULL
            AND o."holdExpiresAt" > ${at}
            AND (oi."admitsAllDays" OR d."id" = ANY(oi."admittedDayIds"))) AS "held"
      FROM "EventDay" d
      WHERE d."id" IN (${Prisma.join(eventDayIds)})
    `;
    return new Map(rows.map((r) => [r.eventDayId, { sold: Number(r.sold), held: Number(r.held) }]));
  },

  // Locks these days' rows (FOR UPDATE, in id order so two checkouts never
  // deadlock) and returns those with a capacity: every hold that counts
  // against a day takes this lock first, so the count read under it can't
  // be overtaken by another hold (ticket-day-capacity.util.ts).
  lockCappedDays: async (tx: Prisma.TransactionClient, eventDayIds: string[]) =>
    eventDayIds.length === 0
      ? []
      : tx.$queryRaw<{ id: string; label: string; date: Date; capacity: number }[]>`
          SELECT "id", "label", "date", "capacity" FROM "EventDay"
          WHERE "id" IN (${Prisma.join([...new Set(eventDayIds)].sort())}) AND "isArchived" = false
          ORDER BY "id"
          FOR UPDATE
        `.then((rows) => rows.filter((r) => r.capacity !== null)),

  // The live days among these ids that have a capacity, with what the
  // capacity messages name.
  findCappedDays: (eventDayIds: string[], db: Db = prisma) =>
    eventDayIds.length === 0
      ? Promise.resolve([])
      : db.eventDay.findMany({
          where: { id: { in: eventDayIds }, isArchived: false, capacity: { not: null } },
          select: { id: true, label: true, date: true, capacity: true },
          orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        }),

  // An event's live VENUE days (a null locationType reads as VENUE): the
  // days an event-level capacity sent by an older frontend is applied to.
  findVenueDayIds: async (eventId: string, db: Db = prisma): Promise<string[]> =>
    (
      await db.eventDay.findMany({
        where: { eventId, isArchived: false, OR: [{ locationType: 'VENUE' }, { locationType: null }] },
        select: { id: true },
      })
    ).map((d) => d.id),

  setCapacity: (eventDayIds: string[], capacity: number | null, userId: string, db: Db = prisma) =>
    eventDayIds.length === 0
      ? Promise.resolve({ count: 0 })
      : db.eventDay.updateMany({ where: { id: { in: eventDayIds } }, data: { capacity, updatedBy: userId } }),
};
