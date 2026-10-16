import { type EventEmailKind, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;

// EventEmailClaim is append-only (schema.prisma): there is deliberately no
// update or delete here.
export const eventEmailClaimRepository = {
  // Serialises claims for one event, so the daily limit is counted and
  // claimed with no other claim committing in between. Same row-lock idiom
  // as announcement.repository.ts's withEventAnnouncementLock.
  withEventEmailLock: <T>(eventId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
        return fn(tx);
      },
      { maxWait: 10_000, timeout: 15_000 }
    ),

  // The claims at or after `since`, oldest first: their sum is what the
  // limit counts, and the oldest says when room starts to come back.
  findSince: (eventId: string, since: Date, tx?: Tx) =>
    (tx ?? prisma).eventEmailClaim.findMany({
      where: { eventId, claimedAt: { gte: since } },
      orderBy: { claimedAt: 'asc' },
      select: { emailCount: true, claimedAt: true },
    }),

  create: (data: { eventId: string; kind: EventEmailKind; emailCount: number; claimedBy: string }, tx?: Tx) =>
    (tx ?? prisma).eventEmailClaim.create({ data }),
};
