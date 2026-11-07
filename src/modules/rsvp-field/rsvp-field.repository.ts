import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from './rsvp-field.types.js';

// Writes take an optional transaction client (the full event update).
type Db = Prisma.TransactionClient | typeof prisma;

export const rsvpFieldRepository = {

  // Sorted by display order, not createdAt — the only sensible sort for a form-field list.
  findAll: (eventId: string) =>
    prisma.rsvpField.findMany({
      where: { eventId, isArchived: false },
      orderBy: { order: 'asc' },
    }),

  findById: (id: string) =>
    prisma.rsvpField.findFirst({
      where: { id, isArchived: false },
    }),

  create: (eventId: string, userId: string, data: CreateRsvpFieldDto, db: Db = prisma) =>
    db.rsvpField.create({
      data: {
        eventId,
        label: data.label,
        fieldType: data.fieldType,
        isRequired: data.isRequired ?? false,
        options: data.options ?? null,
        description: data.description ?? null,
        order: data.order,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateRsvpFieldDto, db: Db = prisma) =>
    db.rsvpField.update({
      where: { id },
      data: {
        ...(data.label !== undefined && { label: data.label }),
        ...(data.fieldType !== undefined && { fieldType: data.fieldType }),
        ...(data.isRequired !== undefined && { isRequired: data.isRequired }),
        ...(data.options !== undefined && { options: data.options ?? null }),
        ...(data.description !== undefined && { description: data.description ?? null }),
        ...(data.order !== undefined && { order: data.order }),
        updatedBy: userId,
      },
    }),

  // Answers guests have given this question, blank ones left out (a blank
  // optional answer is stored, but answers nothing).
  countAnswers: (id: string) =>
    prisma.rsvpResponse.count({ where: { rsvpFieldId: id, NOT: { value: '' } } }),

  archive: (id: string, userId: string, db: Db = prisma) =>
    db.rsvpField.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};
