import { eventProgramRepository } from './event-program.repository.js';
import {} from './event-program.types.js';
export const eventProgramService = {
    getByEventId: async (eventId) => {
        const program = await eventProgramRepository.findByEventId(eventId);
        if (!program)
            throw new Error('Program not found for this event');
        return program;
    },
    getById: async (id) => {
        const program = await eventProgramRepository.findById(id);
        if (!program)
            throw new Error('Program not found');
        return program;
    },
    create: async (eventId, userId, data) => {
        const existing = await eventProgramRepository.findByEventId(eventId);
        if (existing)
            throw new Error('A program already exists for this event');
        return eventProgramRepository.create(eventId, userId, data);
    },
    update: async (id, userId, data) => {
        await eventProgramService.getById(id);
        return eventProgramRepository.update(id, userId, data);
    },
    archive: async (id, userId) => {
        await eventProgramService.getById(id);
        return eventProgramRepository.archive(id, userId);
    },
};
//# sourceMappingURL=event-program.service.js.map