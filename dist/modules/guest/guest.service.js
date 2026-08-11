import { guestRepository } from './guest.repository.js';
import {} from './guest.types.js';
export const guestService = {
    getAll: () => guestRepository.findAll(),
    getById: async (id) => {
        const guest = await guestRepository.findById(id);
        if (!guest)
            throw new Error('Guest not found');
        return guest;
    },
    create: (data) => guestRepository.create(data),
    update: async (id, data) => {
        await guestService.getById(id);
        return guestRepository.update(id, data);
    },
    archive: async (id) => {
        await guestService.getById(id);
        return guestRepository.archive(id);
    },
};
//# sourceMappingURL=guest.service.js.map