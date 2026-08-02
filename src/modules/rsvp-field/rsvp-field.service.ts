import { rsvpFieldRepository } from './rsvp-field.repository.js';
import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from './rsvp-field.types.js';

export const rsvpFieldService = {

  getAll: (eventId: string) => rsvpFieldRepository.findAll(eventId),

  getById: async (id: string) => {
    const field = await rsvpFieldRepository.findById(id);
    if (!field) throw new Error('RSVP field not found');
    return field;
  },

  create: (eventId: string, userId: string, data: CreateRsvpFieldDto) =>
    rsvpFieldRepository.create(eventId, userId, data),

  update: async (id: string, userId: string, data: UpdateRsvpFieldDto) => {
    await rsvpFieldService.getById(id);
    return rsvpFieldRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string) => {
    await rsvpFieldService.getById(id);
    return rsvpFieldRepository.archive(id, userId);
  },
};
