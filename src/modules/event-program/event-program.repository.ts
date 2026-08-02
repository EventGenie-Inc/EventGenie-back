import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateEventProgramDto, type UpdateEventProgramDto } from './event-program.types.js';

export const eventProgramRepository = {

  findByEventId: (eventId: string) =>
    prisma.eventProgram.findFirst({
      where: { eventId, isArchived: false },
      include: {
        programItems: {
          where: { isArchived: false },
          orderBy: { order: 'asc' },
        },
      },
    }),

  findById: (id: string) =>
    prisma.eventProgram.findFirst({
      where: { id, isArchived: false },
      include: {
        programItems: {
          where: { isArchived: false },
          orderBy: { order: 'asc' },
        },
      },
    }),

  create: (eventId: string, userId: string, data: CreateEventProgramDto) =>
    prisma.eventProgram.create({
      data: {
        eventId,
        title: data.title ?? null,
        isPublished: false,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateEventProgramDto) =>
    prisma.eventProgram.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title ?? null }),
        ...(data.isPublished !== undefined && { isPublished: data.isPublished }),
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.eventProgram.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};
