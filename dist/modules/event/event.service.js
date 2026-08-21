import { eventRepository } from './event.repository.js';
import {} from './event.types.js';
import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
export const eventService = {
    getAll: (requestingRole, tenantId) => {
        if (requestingRole === 'SUPER_ADMIN')
            return eventRepository.findAll();
        return eventRepository.findAll(tenantId ?? undefined);
    },
    getById: async (id, requestingRole, tenantId) => {
        const event = requestingRole === 'SUPER_ADMIN'
            ? await eventRepository.findById(id)
            : await eventRepository.findById(id, tenantId ?? undefined);
        if (!event)
            throw new HttpError(404, 'Event not found');
        return event;
    },
    create: async (tenantId, userId, data) => {
        return eventRepository.create(tenantId, userId, data);
    },
    update: async (id, userId, requestingRole, tenantId, data) => {
        await eventService.getById(id, requestingRole, tenantId);
        return eventRepository.update(id, userId, data);
    },
    archive: async (id, userId, requestingRole, tenantId) => {
        await eventService.getById(id, requestingRole, tenantId);
        return eventRepository.archive(id, userId);
    },
};
//# sourceMappingURL=event.service.js.map