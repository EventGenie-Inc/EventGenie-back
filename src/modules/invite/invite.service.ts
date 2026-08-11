import { inviteRepository } from './invite.repository.js';
import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';

export const inviteService = {
  getAll: (eventId: string) => inviteRepository.findAll(eventId),

  getById: async (id: string) => {
    const invite = await inviteRepository.findById(id);
    if (!invite) throw new Error('Invite not found');
    return invite;
  },

  create: (eventId: string, userId: string, data: CreateInviteDto) =>
    inviteRepository.create(eventId, userId, data),

  update: async (id: string, userId: string, data: UpdateInviteDto) => {
    await inviteService.getById(id);
    return inviteRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string) => {
    await inviteService.getById(id);
    return inviteRepository.archive(id, userId);
  },
};