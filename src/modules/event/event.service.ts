import { eventRepository } from './event.repository.js';
import { type CreateEventDto, type UpdateEventDto } from './event.types.js';
import { type PlatformRole } from '@prisma/client';

export const eventService = {

  getAll: (requestingRole: PlatformRole, tenantId: string | null) => {
    if (requestingRole === 'SUPER_ADMIN') return eventRepository.findAll();
    return eventRepository.findAll(tenantId ?? undefined);
  },

  getById: async (id: string) => {
    const event = await eventRepository.findById(id);
    if (!event) throw new Error('Event not found');
    return event;
  },

  create: async (tenantId: string, userId: string, data: CreateEventDto) => {
    return eventRepository.create(tenantId, userId, data);
  },

  update: async (id: string, userId: string, data: UpdateEventDto) => {
    await eventService.getById(id);
    return eventRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string) => {
    await eventService.getById(id);
    return eventRepository.archive(id, userId);
  },
};