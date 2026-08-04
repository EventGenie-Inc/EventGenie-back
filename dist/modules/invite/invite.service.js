import { inviteRepository } from './invite.repository.js';
import {} from './invite.types.js';
export const inviteService = {
    getAll: (eventId) => inviteRepository.findAll(eventId),
    getById: async (id) => {
        const invite = await inviteRepository.findById(id);
        if (!invite)
            throw new Error('Invite not found');
        return invite;
    },
    create: (eventId, userId, data) => inviteRepository.create(eventId, userId, data),
    update: async (id, userId, data) => {
        await inviteService.getById(id);
        return inviteRepository.update(id, userId, data);
    },
    archive: async (id, userId) => {
        await inviteService.getById(id);
        return inviteRepository.archive(id, userId);
    },
};
//# sourceMappingURL=invite.service.js.map