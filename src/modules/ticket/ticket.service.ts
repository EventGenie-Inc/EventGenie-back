import { ticketRepository } from './ticket.repository.js';
import { type CreateTicketDto, type UpdateTicketDto } from './ticket.types.js';

export const ticketService = {

  getAllForAdmin: (eventId: string) => ticketRepository.findAll(eventId),

  getAllPublic: (eventId: string) => ticketRepository.findAll(eventId, { availableOnly: true }),

  getById: async (id: string) => {
    const ticket = await ticketRepository.findById(id);
    if (!ticket) throw new Error('Ticket not found');
    return ticket;
  },

  create: (eventId: string, userId: string, data: CreateTicketDto) =>
    ticketRepository.create(eventId, userId, data),

  update: async (id: string, userId: string, data: UpdateTicketDto) => {
    await ticketService.getById(id);
    return ticketRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string) => {
    await ticketService.getById(id);
    return ticketRepository.archive(id, userId);
  },
};
