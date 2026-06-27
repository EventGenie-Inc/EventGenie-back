import prisma from '../../shared/prisma/prisma.client.js';

export const attendanceRepository = {
  findAll: (inviteId: string) =>
    prisma.attendance.findMany({
      where: { inviteId },
      include: { eventDay: true },
    }),

  findById: (id: string) =>
    prisma.attendance.findFirst({ where: { id }, include: { eventDay: true } }),

  create: (inviteId: string, eventDayId: string) =>
    prisma.attendance.create({ data: { inviteId, eventDayId } }),

  delete: (id: string) => prisma.attendance.delete({ where: { id } }),
};