import { memoryHubRepository } from './memory-hub.repository.js';
import {} from './memory-hub.types.js';
export const memoryHubService = {
    // ── Memory Hub ────────────────────────────
    getByEventId: async (eventId) => {
        const hub = await memoryHubRepository.findByEventId(eventId);
        if (!hub)
            throw new Error('Memory hub not found for this event');
        return hub;
    },
    getById: async (id) => {
        const hub = await memoryHubRepository.findById(id);
        if (!hub)
            throw new Error('Memory hub not found');
        return hub;
    },
    create: async (eventId, userId, data) => {
        const existing = await memoryHubRepository.findByEventId(eventId);
        if (existing)
            throw new Error('A memory hub already exists for this event');
        return memoryHubRepository.create(eventId, userId, data);
    },
    update: async (id, userId, data) => {
        await memoryHubService.getById(id);
        return memoryHubRepository.update(id, userId, data);
    },
    makePublic: async (id, userId) => {
        await memoryHubService.getById(id);
        return memoryHubRepository.generateShareToken(id, userId);
    },
    // Public, unauthenticated view by share token — returns flags rather
    // than throwing on "not public"/"not open yet", since the caller is a
    // guest's browser rendering a page, not an admin flow.
    viewByShareToken: async (shareToken) => {
        const hub = await memoryHubRepository.findByShareToken(shareToken);
        if (!hub)
            throw new Error('Memory hub not found');
        const isOpen = !hub.opensAt || hub.opensAt <= new Date();
        return {
            memoryHub: hub,
            isPublic: hub.isPublic,
            isOpen,
            memoryItems: hub.isPublic && isOpen ? hub.memoryItems : [],
        };
    },
    archive: async (id, userId) => {
        await memoryHubService.getById(id);
        return memoryHubRepository.archive(id, userId);
    },
    // ── Memory Items ──────────────────────────
    getAllItems: (memoryHubId) => memoryHubRepository.findAllItems(memoryHubId),
    getItemById: async (id) => {
        const item = await memoryHubRepository.findItemById(id);
        if (!item)
            throw new Error('Memory item not found');
        return item;
    },
    createItem: (memoryHubId, userId, data) => memoryHubRepository.createItem(memoryHubId, userId, data),
    updateItem: async (id, userId, data) => {
        await memoryHubService.getItemById(id);
        return memoryHubRepository.updateItem(id, userId, data);
    },
    archiveItem: async (id, userId) => {
        await memoryHubService.getItemById(id);
        return memoryHubRepository.archiveItem(id, userId);
    },
};
//# sourceMappingURL=memory-hub.service.js.map