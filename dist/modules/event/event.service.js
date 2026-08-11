import { eventRepository } from './event.repository.js';
import {} from './event.types.js';
import {} from '@prisma/client';
export const eventService = {
    getAll: (requestingRole, tenantId) => {
        if (requestingRole === 'SUPER_ADMIN')
            return eventRepository.findAll();
        return eventRepository.findAll(tenantId ?? undefined);
    },
    getById: async (id) => {
        const event = await eventRepository.findById(id);
        if (!event)
            throw new Error('Event not found');
        return event;
    },
    create: async (tenantId, userId, data) => {
        return eventRepository.create(tenantId, userId, data);
    },
    update: async (id, userId, data) => {
        await eventService.getById(id);
        return eventRepository.update(id, userId, data);
    },
    archive: async (id, userId) => {
        await eventService.getById(id);
        return eventRepository.archive(id, userId);
    },
};
//# sourceMappingURL=event.service.js.map