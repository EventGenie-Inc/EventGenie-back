import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient | typeof prisma;

export const attendanceRepository = {
  findAll: (inviteId: string) =>
    prisma.attendance.findMany({
      where: { inviteId },
      include: { eventDay: true },
    }),

  findById: (id: string) =>
    prisma.attendance.findFirst({ where: { id }, include: { eventDay: true } }),

  // Accepts an optional transaction client — called internally by the
  // RSVP-submit flow inside a prisma.$transaction.
  create: (inviteId: string, eventDayId: string, db: Db = prisma) =>
    db.attendance.create({ data: { inviteId, eventDayId } }),

  delete: (id: string) => prisma.attendance.delete({ where: { id } }),
};