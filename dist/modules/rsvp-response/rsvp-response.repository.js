import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import {} from './rsvp-response.types.js';
export const rsvpResponseRepository = {
    // No isArchived filter — this model has no soft-delete, it's a fact record.
    findAll: (inviteId) => prisma.rsvpResponse.findMany({
        where: { inviteId },
        include: { rsvpField: true },
        orderBy: { createdAt: 'desc' },
    }),
    findById: (id) => prisma.rsvpResponse.findFirst({
        where: { id },
        include: { rsvpField: true },
    }),
    // Accepts an optional transaction client — called internally by the
    // RSVP-submit flow inside a prisma.$transaction.
    create: (inviteId, data, db = prisma) => db.rsvpResponse.create({
        data: {
            inviteId,
            rsvpFieldId: data.rsvpFieldId,
            value: data.value,
        },
    }),
};
//# sourceMappingURL=rsvp-response.repository.js.map