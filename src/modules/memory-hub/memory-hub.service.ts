import { memoryHubRepository } from './memory-hub.repository.js';
import { type CreateMemoryHubDto, type UpdateMemoryHubDto, type CreateMemoryItemDto, type UpdateMemoryItemDto } from './memory-hub.types.js';
import { withEffectiveStatus } from '../event/event-status.util.js';

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

  // Public, unauthenticated view by share token — returns flags rather
  // than throwing on "not public"/"not open yet", since the caller is a
  // guest's browser rendering a page, not an admin flow.
  viewByShareToken: async (shareToken: string) => {
    const hub = await memoryHubRepository.findByShareToken(shareToken);
    if (!hub) throw new Error('Memory hub not found');

    // Access is governed by opensAt alone (below) — deliberately NOT
    // gated by the event's status. A completed event is precisely
    // when memories should be available, so COMPLETED must never
    // block this view. withEffectiveStatus below only makes the
    // reported event.status accurate; it does not participate in isOpen.
    const isOpen = !hub.opensAt || hub.opensAt <= new Date();

    return {
      memoryHub: { ...hub, event: withEffectiveStatus(hub.event) },
      isPublic: hub.isPublic,
      isOpen,
      memoryItems: hub.isPublic && isOpen ? hub.memoryItems : [],
    };
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