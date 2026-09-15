import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';

export const eventDayRepository = {
  findAll: (eventId: string) =>
    prisma.eventDay.findMany({
      where: { eventId, isArchived: false },
      orderBy: { date: 'asc' },
    }),

  findById: (id: string) =>
    prisma.eventDay.findFirst({ where: { id, isArchived: false } }),

  create: (eventId: string, userId: string, data: CreateEventDayDto) =>
    prisma.eventDay.create({
      data: {
        eventId,
        label: data.label,
        date: new Date(data.date),
        // Optional fields: only include if provided, using null explicitly
        startTime: data.startTime ? new Date(data.startTime) : null,
        endTime: data.endTime ? new Date(data.endTime) : null,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateEventDayDto) =>
    prisma.eventDay.update({
      where: { id },
      data: {
        // Only include fields that are explicitly provided — never pass undefined
        ...(data.label !== undefined && { label: data.label }),
        ...(data.date !== undefined && { date: new Date(data.date) }),
        // startTime/endTime are nullable — explicit null must clear them,
        // not fall into new Date(null) (1970-01-01T00:00:00Z), which is
        // what happened when the ?? null guard sat outside the
        // transform instead of inside it. Mirrors create()'s handling.
        ...(data.startTime !== undefined && { startTime: data.startTime ? new Date(data.startTime) : null }),
        ...(data.endTime !== undefined && { endTime: data.endTime ? new Date(data.endTime) : null }),
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.eventDay.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};