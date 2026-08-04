import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import {} from './ticket-purchase.types.js';
export const ticketPurchaseRepository = {
    // No isArchived filter — this model has no soft-delete, it's a financial fact record.
    findAll: (inviteId) => prisma.ticketPurchase.findMany({
        where: { inviteId },
        include: { ticket: true },
        orderBy: { purchasedAt: 'desc' },
    }),
    findById: (id) => prisma.ticketPurchase.findFirst({
        where: { id },
        include: { ticket: true },
    }),
    // Accepts an optional transaction client — called internally by the
    // RSVP-submit flow inside a prisma.$transaction.
    create: (data, db = prisma) => db.ticketPurchase.create({
        data: {
            ticketId: data.ticketId,
            inviteId: data.inviteId,
            quantity: data.quantity ?? 1,
            totalPaid: data.totalPaid,
            currency: data.currency ?? 'ZAR',
            paymentRef: data.paymentRef ?? null,
        },
    }),
};
//# sourceMappingURL=ticket-purchase.repository.js.map