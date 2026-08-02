import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type CreateRsvpResponseDto } from './rsvp-response.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const rsvpResponseRepository = {

  // No isArchived filter — this model has no soft-delete, it's a fact record.
  findAll: (inviteId: string) =>
    prisma.rsvpResponse.findMany({
      where: { inviteId },
      include: { rsvpField: true },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string) =>
    prisma.rsvpResponse.findFirst({
      where: { id },
      include: { rsvpField: true },
    }),

  // Accepts an optional transaction client — called internally by the
  // RSVP-submit flow inside a prisma.$transaction.
  create: (inviteId: string, data: CreateRsvpResponseDto, db: Db = prisma) =>
    db.rsvpResponse.create({
      data: {
        inviteId,
        rsvpFieldId: data.rsvpFieldId,
        value: data.value,
      },
    }),
};
