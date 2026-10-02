import prisma from '../../shared/prisma/prisma.client.js';
import {} from './program-item.types.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
export const programItemRepository = {
    findAll: (programId) => prisma.programItem.findMany({
        where: { programId, isArchived: false },
        orderBy: { order: 'asc' },
    }),
    // The order value that puts a new item at the END of this program's
    // live list: one past the highest order in use, or 0 for the first item.
    nextOrder: async (programId) => {
        const { _max } = await prisma.programItem.aggregate({
            where: { programId, isArchived: false },
            _max: { order: true },
        });
        return _max.order === null ? 0 : _max.order + 1;
    },
    findById: (id) => prisma.programItem.findFirst({
        where: { id, isArchived: false },
    }),
    create: (programId, userId, data) => prisma.programItem.create({
        data: {
            programId,
            title: data.title,
            description: data.description ?? null,
            startTime: parseClientDateTime(data.startTime),
            durationMins: data.durationMins ?? null,
            order: data.order,
            eventDayId: data.eventDayId ?? null,
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
            ...(data.startTime !== undefined && { startTime: parseClientDateTime(data.startTime) }),
            ...(data.durationMins !== undefined && { durationMins: data.durationMins ?? null }),
            ...(data.order !== undefined && { order: data.order }),
            ...(data.eventDayId !== undefined && { eventDayId: data.eventDayId ?? null }),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.programItem.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
};
//# sourceMappingURL=program-item.repository.js.map