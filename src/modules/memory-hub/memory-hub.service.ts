import { memoryHubRepository } from './memory-hub.repository.js';
import { type CreateMemoryHubDto, type UpdateMemoryHubDto, type CreateMemoryItemDto, type UpdateMemoryItemDto } from './memory-hub.types.js';

export const memoryHubService = {

  // ── Memory Hub ────────────────────────────

  getByEventId: async (eventId: string) => {
    const hub = await memoryHubRepository.findByEventId(eventId);
    if (!hub) throw new Error('Memory hub not found for this event');
    return hub;
  },

  getById: async (id: string) => {
    const hub = await memoryHubRepository.findById(id);
    if (!hub) throw new Error('Memory hub not found');
    return hub;
  },

  create: async (eventId: string, userId: string, data: CreateMemoryHubDto) => {
    const existing = await memoryHubRepository.findByEventId(eventId);
    if (existing) throw new Error('A memory hub already exists for this event');
    return memoryHubRepository.create(eventId, userId, data);
  },

  update: async (id: string, userId: string, data: UpdateMemoryHubDto) => {
    await memoryHubService.getById(id);
    return memoryHubRepository.update(id, userId, data);
  },

  makePublic: async (id: string, userId: string) => {
    await memoryHubService.getById(id);
    return memoryHubRepository.generateShareToken(id, userId);
  },

  archive: async (id: string, userId: string) => {
    await memoryHubService.getById(id);
    return memoryHubRepository.archive(id, userId);
  },

  // ── Memory Items ──────────────────────────

  getAllItems: (memoryHubId: string) =>
    memoryHubRepository.findAllItems(memoryHubId),

  getItemById: async (id: string) => {
    const item = await memoryHubRepository.findItemById(id);
    if (!item) throw new Error('Memory item not found');
    return item;
  },

  createItem: (memoryHubId: string, userId: string, data: CreateMemoryItemDto) =>
    memoryHubRepository.createItem(memoryHubId, userId, data),

  updateItem: async (id: string, userId: string, data: UpdateMemoryItemDto) => {
    await memoryHubService.getItemById(id);
    return memoryHubRepository.updateItem(id, userId, data);
  },

  archiveItem: async (id: string, userId: string) => {
    await memoryHubService.getItemById(id);
    return memoryHubRepository.archiveItem(id, userId);
  },
};