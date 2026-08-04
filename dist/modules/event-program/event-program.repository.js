import prisma from '../../shared/prisma/prisma.client.js';
import {} from './event-program.types.js';
export const eventProgramRepository = {
    findByEventId: (eventId) => prisma.eventProgram.findFirst({
        where: { eventId, isArchived: false },
        include: {
            programItems: {
                where: { isArchived: false },
                orderBy: { order: 'asc' },
            },
        },
    }),
    findById: (id) => prisma.eventProgram.findFirst({
        where: { id, isArchived: false },
        include: {
            programItems: {
                where: { isArchived: false },
                orderBy: { order: 'asc' },
            },
        },
    }),
    create: (eventId, userId, data) => prisma.eventProgram.create({
        data: {
            eventId,
            title: data.title ?? null,
            isPublished: false,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    update: (id, userId, data) => prisma.eventProgram.update({
        where: { id },
        data: {
            ...(data.title !== undefined && { title: data.title ?? null }),
            ...(data.isPublished !== undefined && { isPublished: data.isPublished }),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.eventProgram.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
};
//# sourceMappingURL=event-program.repository.js.map