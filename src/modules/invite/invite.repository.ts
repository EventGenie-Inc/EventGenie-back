import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';
import crypto from 'crypto';

export const inviteRepository = {
  findAll: (eventId: string) =>
    prisma.invite.findMany({
      where: { eventId, isArchived: false },
      include: { guest: true, inviteEventDay: { include: { eventDay: true } } },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string) =>
    prisma.invite.findFirst({
      where: { id, isArchived: false },
      include: {
        guest: true,
        inviteEventDay: { include: { eventDay: true } },
        attendances: { include: { eventDay: true } },
      },
    }),

  findByToken: (token: string) =>
    prisma.invite.findUnique({
      where: { token },
      include: { guest: true, inviteEventDay: { include: { eventDay: true } } },
    }),

  create: (eventId: string, userId: string, data: CreateInviteDto) =>
    prisma.$transaction(async (tx) => {
      const invite = await tx.invite.create({
        data: {
          eventId,
          guestId: data.guestId,
          token: crypto.randomBytes(32).toString('hex'),
          status: 'PENDING',
          used: false,
          deliveryMethod: data.deliveryMethod,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      // Create InviteEventDay junction records
      await tx.inviteEventDay.createMany({
        data: data.invitedDayIds.map((eventDayId) => ({
          inviteId: invite.id,
          eventDayId,
        })),
      });

      return invite;
    }),

  update: (id: string, userId: string, data: UpdateInviteDto) =>
    prisma.invite.update({
      where: { id },
      data: {
        ...data,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.invite.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};