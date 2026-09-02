import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
export const attendanceRepository = {
    findAll: (inviteId) => prisma.attendance.findMany({
        where: { inviteId },
        include: { eventDay: true },
    }),
    findById: (id) => prisma.attendance.findFirst({ where: { id }, include: { eventDay: true, invite: true } }),
    // Accepts an optional transaction client — called internally by the
    // RSVP-submit flow inside a prisma.$transaction.
    create: (inviteId, eventDayId, db = prisma) => db.attendance.create({ data: { inviteId, eventDayId } }),
    delete: (id) => prisma.attendance.delete({ where: { id } }),
};
//# sourceMappingURL=attendance.repository.js.map