import { eventRepository } from './event.repository.js';
import { type CreateEventDto, type UpdateEventDto } from './event.types.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';

export const eventService = {

  getAll: (requestingRole: PlatformRole, tenantId: string | null) => {
    if (requestingRole === 'SUPER_ADMIN') return eventRepository.findAll();
    return eventRepository.findAll(tenantId ?? undefined);
  },

  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = requestingRole === 'SUPER_ADMIN'
      ? await eventRepository.findById(id)
      : await eventRepository.findById(id, tenantId ?? undefined);

    if (!event) throw new HttpError(404, 'Event not found');
    return event;
  },

  create: async (tenantId: string, userId: string, data: CreateEventDto) => {
    return eventRepository.create(tenantId, userId, data);
  },

  update: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDto) => {
    await eventService.getById(id, requestingRole, tenantId);
    return eventRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getById(id, requestingRole, tenantId);
    return eventRepository.archive(id, userId);
  },
};