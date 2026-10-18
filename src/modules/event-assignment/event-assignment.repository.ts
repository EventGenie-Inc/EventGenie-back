import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// EventAssignment rows: which EVENT_ADMIN works on which event. Prisma
// queries only; the rule that reads them is event-assignment-lock.util.ts.
// Every write takes the tenantId it was checked against, and callers pass
// a tenant the user AND the event were both confirmed to belong to
// (team.service.ts), so a row never joins two tenants.
export const eventAssignmentRepository = {

  // Archived events included on purpose — see the model's own comment.
  findEventIdsForUser: async (userId: string): Promise<string[]> =>
    (await prisma.eventAssignment.findMany({ where: { userId }, select: { eventId: true } })).map((a) => a.eventId),

  // For the team member list: every assignment in the tenant, with just
  // what the list shows of each event.
  findForTenant: (tenantId: string) =>
    prisma.eventAssignment.findMany({
      where: { tenantId },
      select: {
        userId: true,
        event: { select: { id: true, name: true, isArchived: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),

  countForUser: (userId: string, tx: Tx = prisma) => tx.eventAssignment.count({ where: { userId } }),

  // Replaces a user's whole assignment list with eventIds, in one
  // transaction: removes the rows no longer wanted, adds the new ones.
  replaceForUser: (tenantId: string, userId: string, eventIds: string[], createdBy: string) =>
    prisma.$transaction(async (tx) => {
      await tx.eventAssignment.deleteMany({ where: { userId, eventId: { notIn: eventIds } } });
      if (eventIds.length) {
        await tx.eventAssignment.createMany({
          data: eventIds.map((eventId) => ({ tenantId, userId, eventId, createdBy })),
          skipDuplicates: true,
        });
      }
    }),

  createMany: (tx: Tx, tenantId: string, userId: string, eventIds: string[], createdBy: string) =>
    tx.eventAssignment.createMany({
      data: eventIds.map((eventId) => ({ tenantId, userId, eventId, createdBy })),
      skipDuplicates: true,
    }),

  create: (tx: Tx, tenantId: string, userId: string, eventId: string, createdBy: string) =>
    tx.eventAssignment.create({ data: { tenantId, userId, eventId, createdBy } }),

  deleteAllForUser: (tx: Tx, userId: string) => tx.eventAssignment.deleteMany({ where: { userId } }),
};
