import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import {} from './ticket.types.js';
export const ticketRepository = {
    findAll: (eventId, opts) => prisma.ticket.findMany({
        where: {
            eventId,
            isArchived: false,
            ...(opts?.availableOnly ? { isAvailable: true } : {}),
        },
        orderBy: { createdAt: 'desc' },
    }),
    findById: (id) => prisma.ticket.findFirst({
        where: { id, isArchived: false },
    }),
    create: (eventId, userId, data) => prisma.ticket.create({
        data: {
            eventId,
            name: data.name,
            description: data.description ?? null,
            price: data.price,
            currency: data.currency ?? 'ZAR',
            totalQuantity: data.totalQuantity ?? null,
            soldCount: 0,
            isAvailable: true,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    update: (id, userId, data) => prisma.ticket.update({
        where: { id },
        data: {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.description !== undefined && { description: data.description ?? null }),
            ...(data.price !== undefined && { price: data.price }),
            ...(data.currency !== undefined && { currency: data.currency }),
            ...(data.totalQuantity !== undefined && { totalQuantity: data.totalQuantity ?? null }),
            ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.ticket.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    // Accepts an optional transaction client so it can be called both
    // standalone and inside the RSVP-submit prisma.$transaction.
    incrementSoldCount: (id, quantity, db = prisma) => db.ticket.update({
        where: { id },
        data: { soldCount: { increment: quantity } },
    }),
};
//# sourceMappingURL=ticket.repository.js.map