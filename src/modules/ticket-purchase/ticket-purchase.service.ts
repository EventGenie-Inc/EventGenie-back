import { ticketPurchaseRepository } from './ticket-purchase.repository.js';

export const ticketPurchaseService = {

  getAll: (inviteId: string) => ticketPurchaseRepository.findAll(inviteId),

  getById: async (id: string) => {
    const purchase = await ticketPurchaseRepository.findById(id);
    if (!purchase) throw new Error('Ticket purchase not found');
    return purchase;
  },
};
