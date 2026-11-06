import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type UpsertEventDraftDto } from './event-draft.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const eventDraftRepository = {
  findByTenantAndUser: (tenantId: string, userId: string) =>
    prisma.eventDraft.findUnique({
      where: { tenantId_createdByUserId: { tenantId, createdByUserId: userId } },
    }),

  findById: (id: string) =>
    prisma.eventDraft.findUnique({ where: { id } }),

  upsert: (tenantId: string, userId: string, data: UpsertEventDraftDto, db: Db = prisma) =>
    db.eventDraft.upsert({
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

  delete: (id: string, db: Db = prisma) =>
    db.eventDraft.delete({ where: { id } }),

  // Drafts untouched since `cutoff`, oldest first.
  findStale: (cutoff: Date, take: number) =>
    prisma.eventDraft.findMany({ where: { updatedAt: { lt: cutoff } }, select: { id: true }, orderBy: { updatedAt: 'asc' }, take }),

  // Deleted only if still untouched since `cutoff`: a draft saved in the
  // meantime is kept. Returns whether it was deleted.
  deleteIfStale: async (id: string, cutoff: Date, db: Db): Promise<boolean> =>
    (await db.eventDraft.deleteMany({ where: { id, updatedAt: { lt: cutoff } } })).count === 1,
};
