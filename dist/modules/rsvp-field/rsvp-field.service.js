import { rsvpFieldRepository } from './rsvp-field.repository.js';
import {} from './rsvp-field.types.js';
export const rsvpFieldService = {
    getAll: (eventId) => rsvpFieldRepository.findAll(eventId),
    getById: async (id) => {
        const field = await rsvpFieldRepository.findById(id);
        if (!field)
            throw new Error('RSVP field not found');
        return field;
    },
    create: (eventId, userId, data) => rsvpFieldRepository.create(eventId, userId, data),
    update: async (id, userId, data) => {
        await rsvpFieldService.getById(id);
        return rsvpFieldRepository.update(id, userId, data);
    },
    archive: async (id, userId) => {
        await rsvpFieldService.getById(id);
        return rsvpFieldRepository.archive(id, userId);
    },
};
//# sourceMappingURL=rsvp-field.service.js.map