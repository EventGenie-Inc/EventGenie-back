import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type CreateTicketDto, type UpdateTicketDto } from './ticket.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const ticketRepository = {

  findAll: (eventId: string, opts?: { availableOnly?: boolean }) =>
    prisma.ticket.findMany({
      where: {
        eventId,
        isArchived: false,
        ...(opts?.availableOnly ? { isAvailable: true } : {}),
      },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string) =>
    prisma.ticket.findFirst({
      where: { id, isArchived: false },
    }),

  create: (eventId: string, userId: string, data: CreateTicketDto) =>
    prisma.ticket.create({
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

  update: (id: string, userId: string, data: UpdateTicketDto) =>
    prisma.ticket.update({
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

  archive: (id: string, userId: string) =>
    prisma.ticket.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),

  // Accepts an optional transaction client so it can be called both
  // standalone and inside the RSVP-submit prisma.$transaction.
  incrementSoldCount: (id: string, quantity: number, db: Db = prisma) =>
    db.ticket.update({
      where: { id },
      data: { soldCount: { increment: quantity } },
    }),
};
