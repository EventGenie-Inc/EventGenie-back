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
        ...(data.startTime !== undefined && { startTime: new Date(data.startTime) }),
        ...(data.endTime !== undefined && { endTime: new Date(data.endTime) }),
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.eventDay.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};