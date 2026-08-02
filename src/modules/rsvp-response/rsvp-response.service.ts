import { rsvpResponseRepository } from './rsvp-response.repository.js';

export const rsvpResponseService = {

  getAll: (inviteId: string) => rsvpResponseRepository.findAll(inviteId),

  getById: async (id: string) => {
    const response = await rsvpResponseRepository.findById(id);
    if (!response) throw new Error('RSVP response not found');
    return response;
  },
};
