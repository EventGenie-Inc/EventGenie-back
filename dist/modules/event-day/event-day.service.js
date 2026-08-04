import { eventDayRepository } from './event-day.repository.js';
import {} from './event-day.types.js';
export const eventDayService = {
    getAll: (eventId) => eventDayRepository.findAll(eventId),
    getById: async (id) => {
        const day = await eventDayRepository.findById(id);
        if (!day)
            throw new Error('Event day not found');
        return day;
    },
    create: (eventId, userId, data) => eventDayRepository.create(eventId, userId, data),
    update: async (id, userId, data) => {
        await eventDayService.getById(id);
        return eventDayRepository.update(id, userId, data);
    },
    archive: async (id, userId) => {
        await eventDayService.getById(id);
        return eventDayRepository.archive(id, userId);
    },
};
//# sourceMappingURL=event-day.service.js.map