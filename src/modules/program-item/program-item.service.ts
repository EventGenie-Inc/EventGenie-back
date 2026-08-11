import { programItemRepository } from './program-item.repository.js';
import { type CreateProgramItemDto, type UpdateProgramItemDto } from './program-item.types.js';

export const programItemService = {

  getAll: (programId: string) => programItemRepository.findAll(programId),

  getById: async (id: string) => {
    const item = await programItemRepository.findById(id);
    if (!item) throw new Error('Program item not found');
    return item;
  },

  create: (programId: string, userId: string, data: CreateProgramItemDto) =>
    programItemRepository.create(programId, userId, data),

  update: async (id: string, userId: string, data: UpdateProgramItemDto) => {
    await programItemService.getById(id);
    return programItemRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string) => {
    await programItemService.getById(id);
    return programItemRepository.archive(id, userId);
  },
};
