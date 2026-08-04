import prisma from '../../shared/prisma/prisma.client.js';
import {} from './program-item.types.js';
export const programItemRepository = {
    findAll: (programId) => prisma.programItem.findMany({
        where: { programId, isArchived: false },
        orderBy: { order: 'asc' },
    }),
    findById: (id) => prisma.programItem.findFirst({
        where: { id, isArchived: false },
    }),
    create: (programId, userId, data) => prisma.programItem.create({
        data: {
            programId,
            title: data.title,
            description: data.description ?? null,
            startTime: new Date(data.startTime),
            durationMins: data.durationMins ?? null,
            order: data.order,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    update: (id, userId, data) => prisma.programItem.update({
        where: { id },
        data: {
            ...(data.title !== undefined && { title: data.title }),
            ...(data.description !== undefined && { description: data.description ?? null }),
            ...(data.startTime !== undefined && { startTime: new Date(data.startTime) }),
            ...(data.durationMins !== undefined && { durationMins: data.durationMins ?? null }),
            ...(data.order !== undefined && { order: data.order }),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.programItem.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
};
//# sourceMappingURL=program-item.repository.js.map