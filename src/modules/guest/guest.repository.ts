import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateGuestDto, type UpdateGuestDto } from './guest.types.js';

export const guestRepository = {
  findAll: () =>
    prisma.guest.findMany({ where: { isArchived: false }, orderBy: { createdAt: 'desc' } }),

  findById: (id: string) =>
    prisma.guest.findFirst({ where: { id, isArchived: false } }),

  findByEmail: (email: string) =>
    prisma.guest.findFirst({ where: { email, isArchived: false } }),

  create: (data: CreateGuestDto) =>
    prisma.guest.create({
      data: { ...data, isArchived: false },
    }),

  update: (id: string, data: UpdateGuestDto) =>
    prisma.guest.update({ where: { id }, data }),

  archive: (id: string) =>
    prisma.guest.update({ where: { id }, data: { isArchived: true } }),
};