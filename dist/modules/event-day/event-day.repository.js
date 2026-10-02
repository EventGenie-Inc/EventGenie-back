import prisma from '../../shared/prisma/prisma.client.js';
import { withPlainDayCoordinates } from '../event/event-coordinates.util.js';
import {} from './event-day-venue.util.js';
export const eventDayRepository = {
    findAll: async (eventId) => (await prisma.eventDay.findMany({
        where: { eventId, isArchived: false },
        orderBy: { date: 'asc' },
    })).map(withPlainDayCoordinates),
    findById: async (id) => {
        const day = await prisma.eventDay.findFirst({ where: { id, isArchived: false } });
        return day ? withPlainDayCoordinates(day) : null;
    },
    create: (eventId, userId, data) => prisma.eventDay
        .create({
        data: {
            eventId,
            label: data.label,
            date: data.date,
            startTime: data.startTime,
            endTime: data.endTime,
            location: data.venue.location,
            address: data.venue.address,
            latitude: data.venue.latitude,
            longitude: data.venue.longitude,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    })
        .then(withPlainDayCoordinates),
    // The venue is always written in full: the service has already merged
    // the request with the stored day (event-day-venue.util.ts), including
    // clearing coordinates when the address changed without new ones.
    update: (id, userId, data) => prisma.eventDay
        .update({
        where: { id },
        data: {
            ...(data.label !== undefined && { label: data.label }),
            ...(data.date !== undefined && { date: data.date }),
            ...(data.startTime !== undefined && { startTime: data.startTime }),
            ...(data.endTime !== undefined && { endTime: data.endTime }),
            location: data.venue.location,
            address: data.venue.address,
            latitude: data.venue.latitude,
            longitude: data.venue.longitude,
            updatedBy: userId,
        },
    })
        .then(withPlainDayCoordinates),
    archive: (id, userId) => prisma.eventDay.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
};
//# sourceMappingURL=event-day.repository.js.map