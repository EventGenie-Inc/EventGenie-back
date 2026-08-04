import { ticketPurchaseRepository } from './ticket-purchase.repository.js';
export const ticketPurchaseService = {
    getAll: (inviteId) => ticketPurchaseRepository.findAll(inviteId),
    getById: async (id) => {
        const purchase = await ticketPurchaseRepository.findById(id);
        if (!purchase)
            throw new Error('Ticket purchase not found');
        return purchase;
    },
};
//# sourceMappingURL=ticket-purchase.service.js.map