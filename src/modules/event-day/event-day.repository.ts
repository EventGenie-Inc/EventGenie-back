import { type Prisma } from '@prisma/client';
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
          updatedBy: userId,
        },
      })
      .then(withPlainDayCoordinates),

  archive: (id: string, userId: string, db: Db = prisma) =>
    db.eventDay.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};
