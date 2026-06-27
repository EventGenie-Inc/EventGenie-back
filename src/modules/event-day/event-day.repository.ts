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
        ...data,
        date: data.date ? new Date(data.date) : undefined,
        startTime: data.startTime ? new Date(data.startTime) : undefined,
        endTime: data.endTime ? new Date(data.endTime) : undefined,
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.eventDay.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};