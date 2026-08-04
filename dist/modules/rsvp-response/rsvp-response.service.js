import { rsvpResponseRepository } from './rsvp-response.repository.js';
export const rsvpResponseService = {
    getAll: (inviteId) => rsvpResponseRepository.findAll(inviteId),
    getById: async (id) => {
        const response = await rsvpResponseRepository.findById(id);
        if (!response)
            throw new Error('RSVP response not found');
        return response;
    },
};
//# sourceMappingURL=rsvp-response.service.js.map