import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type UpsertEventDraftDto } from './event-draft.types.js';

export const eventDraftRepository = {
  findByTenantAndUser: (tenantId: string, userId: string) =>
    prisma.eventDraft.findUnique({
      where: { tenantId_createdByUserId: { tenantId, createdByUserId: userId } },
    }),

  findById: (id: string) =>
    prisma.eventDraft.findUnique({ where: { id } }),

  upsert: (tenantId: string, userId: string, data: UpsertEventDraftDto) =>
    prisma.eventDraft.upsert({
      where: { tenantId_createdByUserId: { tenantId, createdByUserId: userId } },
      create: {
        tenantId,
        createdByUserId: userId,
        currentStep: data.currentStep,
        payload: data.payload as Prisma.InputJsonValue,
      },
      update: {
        currentStep: data.currentStep,
        payload: data.payload as Prisma.InputJsonValue,
      },
    }),

  delete: (id: string) =>
    prisma.eventDraft.delete({ where: { id } }),
};
