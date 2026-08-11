import { guestRepository } from './guest.repository.js';
import { type CreateGuestDto, type UpdateGuestDto } from './guest.types.js';

export const guestService = {
  getAll: () => guestRepository.findAll(),

  getById: async (id: string) => {
    const guest = await guestRepository.findById(id);
    if (!guest) throw new Error('Guest not found');
    return guest;
  },

  create: (data: CreateGuestDto) => guestRepository.create(data),

  update: async (id: string, data: UpdateGuestDto) => {
    await guestService.getById(id);
    return guestRepository.update(id, data);
  },

  archive: async (id: string) => {
    await guestService.getById(id);
    return guestRepository.archive(id);
  },
};