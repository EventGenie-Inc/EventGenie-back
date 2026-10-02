import { Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { type PutInvitationDesignDto } from './invitation-design.types.js';

// Every column for BOTH kinds, every time: switching kind rewrites the
// same row and must null the other kind's columns (the migration's CHECK
// constraint refuses a row that keeps both). A nullable Json column is
// cleared with Prisma.DbNull, not null.
const columnsFor = (data: PutInvitationDesignDto) =>
  data.kind === 'TEMPLATE'
    ? {
        kind: 'TEMPLATE' as const,
        templateId: data.templateId,
        templateVersion: data.templateVersion,
        overrides: data.overrides as unknown as Prisma.InputJsonValue,
        imageUrl: null,
        cloudinaryPublicId: null,
        width: null,
        height: null,
        altText: null,
      }
    : {
        kind: 'UPLOAD' as const,
        templateId: null,
        templateVersion: null,
        overrides: Prisma.DbNull,
        imageUrl: data.imageUrl,
        cloudinaryPublicId: data.cloudinaryPublicId,
        width: data.width,
        height: data.height,
        altText: data.altText ?? null,
      };

// Scoping: InvitationDesign has no tenantId of its own. Every caller has
// already passed the event through eventService's tenant-scoped gate
// (transitive scoping, see STEERING), so these take a trusted eventId.
export const invitationDesignRepository = {
  findActiveByEventId: (eventId: string) =>
    prisma.invitationDesign.findFirst({ where: { eventId, isArchived: false } }),

  update: (id: string, userId: string, data: PutInvitationDesignDto) =>
    prisma.invitationDesign.update({
      where: { id },
      data: { ...columnsFor(data), updatedBy: userId },
    }),

  create: (eventId: string, userId: string, data: PutInvitationDesignDto) =>
    prisma.invitationDesign.create({
      data: { eventId, ...columnsFor(data), isArchived: false, createdBy: userId, updatedBy: userId },
    }),
};

// The partial unique index ("InvitationDesign_eventId_active_key") firing:
// two first-ever PUTs for the same event raced and the other one won.
export const isActiveDesignUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
