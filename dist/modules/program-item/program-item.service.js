import { programItemRepository } from './program-item.repository.js';
import {} from './program-item.types.js';
export const programItemService = {
    getAll: (programId) => programItemRepository.findAll(programId),
    getById: async (id) => {
        const item = await programItemRepository.findById(id);
        if (!item)
            throw new Error('Program item not found');
        return item;
    },
    create: (programId, userId, data) => programItemRepository.create(programId, userId, data),
    update: async (id, userId, data) => {
        await programItemService.getById(id);
        return programItemRepository.update(id, userId, data);
    },
    archive: async (id, userId) => {
        await programItemService.getById(id);
        return programItemRepository.archive(id, userId);
    },
};
//# sourceMappingURL=program-item.service.js.map