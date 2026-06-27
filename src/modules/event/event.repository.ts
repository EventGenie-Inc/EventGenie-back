import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateEventDto, type UpdateEventDto } from './event.types.js';

export const eventRepository = {

  findAll: (tenantId?: string) =>
    prisma.event.findMany({
      where: {
        isArchived: false,
        ...(tenantId ? { tenantId } : {}),
      },
      include: { eventDays: { where: { isArchived: false } } },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string) =>
    prisma.event.findFirst({
      where: { id, isArchived: false },
      include: {
        eventDays: { where: { isArchived: false } },
        memoryHub: true,
      },
    }),

  create: (tenantId: string, userId: string, data: CreateEventDto) =>
    prisma.event.create({
      data: {
        tenantId,
        createdByUserId: userId,
        name: data.name,
        description: data.description,
        location: data.location,
        address: data.address,
        latitude: data.latitude,
        longitude: data.longitude,
        coverImageUrl: data.coverImageUrl,
        status: 'DRAFT',
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateEventDto) =>
    prisma.event.update({
      where: { id },
      data: { ...data, updatedBy: userId, updatedAt: new Date() },
    }),

  archive: (id: string, userId: string) =>
    prisma.event.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};