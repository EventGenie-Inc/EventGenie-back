import { ticketRepository } from './ticket.repository.js';
import {} from './ticket.types.js';
export const ticketService = {
    getAllForAdmin: (eventId) => ticketRepository.findAll(eventId),
    getAllPublic: (eventId) => ticketRepository.findAll(eventId, { availableOnly: true }),
    getById: async (id) => {
        const ticket = await ticketRepository.findById(id);
        if (!ticket)
            throw new Error('Ticket not found');
        return ticket;
    },
    create: (eventId, userId, data) => ticketRepository.create(eventId, userId, data),
    update: async (id, userId, data) => {
        await ticketService.getById(id);
        return ticketRepository.update(id, userId, data);
    },
    archive: async (id, userId) => {
        await ticketService.getById(id);
        return ticketRepository.archive(id, userId);
    },
};
//# sourceMappingURL=ticket.service.js.map