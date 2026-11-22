import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { centsToDecimalString } from '../../shared/payments/money.util.js';
import { type TicketTypeWrite } from './ticket.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// Every ticket read carries its admitted days (the chosen ones, when it
// doesn't admit every day).
const withDays = { admittedDays: { select: { eventDayId: true } } } as const;

export type TicketRow = Prisma.TicketGetPayload<{ include: typeof withDays }>;

// The columns a write sets. priceCents is the source of truth; the old
// decimal price is written in step (deprecated, still read by the
// invitation purchase path), and isAvailable follows the status.
const columnsOf = (data: TicketTypeWrite) => ({
  name: data.name,
  description: data.description,
  priceCents: data.priceCents,
  price: centsToDecimalString(data.priceCents),
  totalQuantity: data.totalQuantity,
  salesStart: data.salesStart,
  salesEnd: data.salesEnd,
  admitsAllDays: data.admitsAllDays,
  maxPerOrder: data.maxPerOrder,
  sortOrder: data.sortOrder,
  status: data.status,
  isAvailable: data.status === 'ACTIVE',
});

export const ticketRepository = {

  // Live types, in the organiser's order.
  findAll: (eventId: string, db: Db = prisma) =>
    db.ticket.findMany({
      where: { eventId, isArchived: false },
      include: withDays,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),

  findById: (id: string, db: Db = prisma) =>
    db.ticket.findFirst({ where: { id, isArchived: false }, include: withDays }),

  nextSortOrder: async (eventId: string, db: Db = prisma): Promise<number> => {
    const last = await db.ticket.findFirst({ where: { eventId, isArchived: false }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    return last ? last.sortOrder + 1 : 0;
  },

  create: (eventId: string, userId: string, data: TicketTypeWrite, db: Db = prisma) =>
    db.ticket.create({
      data: {
        eventId,
        ...columnsOf(data),
        currency: 'ZAR',
        soldCount: 0,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
        ...(!data.admitsAllDays && { admittedDays: { create: data.admittedDayIds.map((eventDayId) => ({ eventDayId })) } }),
      },
      include: withDays,
    }),

  // The whole type as resolved (ticket-validation.util.ts's resolveTicketType);
  // its admitted days replaced.
  update: async (id: string, userId: string, data: TicketTypeWrite, db: Db = prisma) => {
    await db.ticketAdmittedDay.deleteMany({ where: { ticketId: id } });
    return db.ticket.update({
      where: { id },
      data: {
        ...columnsOf(data),
        updatedBy: userId,
        ...(!data.admitsAllDays && { admittedDays: { create: data.admittedDayIds.map((eventDayId) => ({ eventDayId })) } }),
      },
      include: withDays,
    });
  },

  archive: (id: string, userId: string, db: Db = prisma) =>
    db.ticket.update({ where: { id }, data: { isArchived: true, updatedBy: userId } }),

  // The event's live types that admit `eventDayId`: every type that admits
  // all days, and those that chose it.
  findAdmitting: (eventId: string, eventDayId: string, db: Db = prisma) =>
    db.ticket.findMany({
      where: { eventId, isArchived: false, OR: [{ admitsAllDays: true }, { admittedDays: { some: { eventDayId } } }] },
      include: withDays,
    }),

  // A removed day is no longer any type's: its chosen-day rows go with it.
  forgetDay: (eventDayId: string, db: Db = prisma) => db.ticketAdmittedDay.deleteMany({ where: { eventDayId } }),

  // ─────────────────────────────────────────
  //  STOCK — the invitation purchase path (ticket-purchase.service.ts)
  //
  //  Overselling is prevented at reserveHold: one conditional UPDATE, so two
  //  checkouts for the last ticket can't both get it. incrementSoldCount and
  //  releaseHold only move what a reserveHold already secured.
  // ─────────────────────────────────────────

  reserveHold: async (ticketId: string, quantity: number, db: Db = prisma): Promise<boolean> => {
    const affected = await db.$executeRaw`
      UPDATE "Ticket"
      SET "heldCount" = "heldCount" + ${quantity}
      WHERE "id" = ${ticketId}
        AND "isArchived" = false
        AND "isAvailable" = true
        AND ("totalQuantity" IS NULL OR "soldCount" + "heldCount" + ${quantity} <= "totalQuantity")
    `;
    return affected === 1;
  },

  releaseHold: (ticketId: string, quantity: number, db: Db = prisma) =>
    db.ticket.update({ where: { id: ticketId }, data: { heldCount: { decrement: quantity } } }),

  incrementSoldCount: (id: string, quantity: number, db: Db = prisma) =>
    db.ticket.update({ where: { id }, data: { soldCount: { increment: quantity } } }),
};
