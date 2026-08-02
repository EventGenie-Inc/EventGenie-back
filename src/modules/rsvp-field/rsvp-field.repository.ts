import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from './rsvp-field.types.js';

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

  create: (eventId: string, userId: string, data: CreateRsvpFieldDto) =>
    prisma.rsvpField.create({
      data: {
        eventId,
        label: data.label,
        fieldType: data.fieldType,
        isRequired: data.isRequired ?? false,
        options: data.options ?? null,
        order: data.order,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateRsvpFieldDto) =>
    prisma.rsvpField.update({
      where: { id },
      data: {
        ...(data.label !== undefined && { label: data.label }),
        ...(data.fieldType !== undefined && { fieldType: data.fieldType }),
        ...(data.isRequired !== undefined && { isRequired: data.isRequired }),
        ...(data.options !== undefined && { options: data.options ?? null }),
        ...(data.order !== undefined && { order: data.order }),
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.rsvpField.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};
