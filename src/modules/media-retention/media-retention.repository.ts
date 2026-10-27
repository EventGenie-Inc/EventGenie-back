import { type EventMediaPurge, type EventMediaPurgeReason } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { EVENT_ORGANISERS_SELECT } from '../event-assignment/event-organisers.util.js';

// Prisma queries only; the rules are media-retention.service.ts's.

// A cutoff for raw SQL against a TIMESTAMP (no time zone) column, which
// holds UTC: the ISO string cast to timestamp, whose "Z" Postgres ignores.
// A bare Date parameter would be compared in the session's time zone.
const utcTimestamp = (date: Date): string => date.toISOString();

// What the organisers could download (the Memory Hub download's own rule:
// live, approved, in the live hub) and that hasn't been purged.
const downloadableItemWhere = (eventId: string) => ({
  memoryHub: { eventId, isArchived: false },
  isArchived: false,
  status: 'APPROVED' as const,
  purgedAt: null,
});

export type PurgeClaim =
  | { outcome: 'CLAIMED'; purge: EventMediaPurge }
  // A purge already exists for this archiving.
  | { outcome: 'EXISTS'; purge: EventMediaPurge }
  | { outcome: 'NOT_ARCHIVED' }
  | { outcome: 'NOT_DUE' };

export const mediaRetentionRepository = {

  // ── The reminder ──────────────────────────

  // Events archived at or before remindFrom (so the reminder is due, or
  // late: it has no upper bound, since a purge waits for it), still
  // archived, with something to download, never reminded and never purged
  // for this archiving.
  findReminderCandidates: async (remindFrom: Date): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id"
      FROM "Event" e
      WHERE e."isArchived" = true
        AND e."archivedAt" IS NOT NULL
        AND e."archivedAt" <= ${utcTimestamp(remindFrom)}::timestamp
        AND NOT EXISTS (
          SELECT 1 FROM "MediaPurgeReminderClaim" c WHERE c."eventId" = e."id" AND c."archivedAt" = e."archivedAt"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "EventMediaPurge" p WHERE p."eventId" = e."id" AND p."archivedAt" = e."archivedAt"
        )
        AND EXISTS (
          SELECT 1 FROM "MemoryItem" i JOIN "MemoryHub" h ON h."id" = i."memoryHubId"
          WHERE h."eventId" = e."id" AND h."isArchived" = false
            AND i."isArchived" = false AND i."status" = 'APPROVED'::"MemoryItemStatus" AND i."purgedAt" IS NULL
        )
      ORDER BY e."id"
    `;
    return rows.map((r) => r.id);
  },

  findEventForReminder: (eventId: string) =>
    prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true, isArchived: true, archivedAt: true, ...EVENT_ORGANISERS_SELECT },
    }),

  countDownloadableItems: (eventId: string) => prisma.memoryItem.count({ where: downloadableItemWhere(eventId) }),

  purgeExists: async (eventId: string, archivedAt: Date): Promise<boolean> =>
    (await prisma.eventMediaPurge.count({ where: { eventId, archivedAt } })) > 0,

  // The claim: one row per event and archiving (the unique index). False
  // when another sweep claimed it first. claimedAt is the sweep's own
  // `now`, the time the email's date was worked out from, so the purge
  // waits exactly as long as the email said.
  claimReminder: async (eventId: string, archivedAt: Date, recipientCount: number, claimedAt: Date): Promise<boolean> =>
    (
      await prisma.mediaPurgeReminderClaim.createMany({
        data: [{ eventId, archivedAt, recipientCount, claimedAt }],
        skipDuplicates: true,
      })
    ).count === 1,

  // ── The purge ─────────────────────────────

  // Events archived at or before dueBy, still archived, with no purge for
  // this archiving yet, AND either reminded at or before remindedBy (a week
  // ago) or with nothing to download, so needing no reminder. An event
  // whose reminder is late waits for it (findReminderCandidates).
  findDuePurgeEventIds: async (dueBy: Date, remindedBy: Date): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id"
      FROM "Event" e
      WHERE e."isArchived" = true
        AND e."archivedAt" IS NOT NULL
        AND e."archivedAt" <= ${utcTimestamp(dueBy)}::timestamp
        AND NOT EXISTS (
          SELECT 1 FROM "EventMediaPurge" p WHERE p."eventId" = e."id" AND p."archivedAt" = e."archivedAt"
        )
        AND (
          EXISTS (
            SELECT 1 FROM "MediaPurgeReminderClaim" c
            WHERE c."eventId" = e."id" AND c."archivedAt" = e."archivedAt"
              AND c."claimedAt" <= ${utcTimestamp(remindedBy)}::timestamp
          )
          OR NOT EXISTS (
            SELECT 1 FROM "MemoryItem" i JOIN "MemoryHub" h ON h."id" = i."memoryHubId"
            WHERE h."eventId" = e."id" AND h."isArchived" = false
              AND i."isArchived" = false AND i."status" = 'APPROVED'::"MemoryItemStatus" AND i."purgedAt" IS NULL
          )
        )
      ORDER BY e."archivedAt", e."id"
    `;
    return rows.map((r) => r.id);
  },

  // Claims the purge of an archived event, under the event's row lock: a
  // restore (event.repository.ts's reactivate) writes the same row, so it
  // lands either before (the event is no longer archived: nothing claimed)
  // or after (the purge stands). dueBy: the latest archivedAt that is due
  // (the sweep); null claims it now (a super admin). The unique
  // (eventId, archivedAt) makes the claim once, however many race.
  claimPurge: (
    eventId: string,
    claim: { reason: EventMediaPurgeReason; requestedBy: string | null; dueBy: Date | null; now: Date }
  ): Promise<PurgeClaim> =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
      const event = await tx.event.findUnique({ where: { id: eventId }, select: { isArchived: true, archivedAt: true } });
      if (!event || !event.isArchived || !event.archivedAt) return { outcome: 'NOT_ARCHIVED' as const };
      if (claim.dueBy && event.archivedAt > claim.dueBy) return { outcome: 'NOT_DUE' as const };

      const key = { eventId_archivedAt: { eventId, archivedAt: event.archivedAt } };
      const { count } = await tx.eventMediaPurge.createMany({
        data: [{
          eventId,
          archivedAt: event.archivedAt,
          reason: claim.reason,
          requestedBy: claim.requestedBy,
          startedAt: claim.now,
        }],
        skipDuplicates: true,
      });
      const purge = await tx.eventMediaPurge.findUniqueOrThrow({ where: key });
      return { outcome: count === 1 ? ('CLAIMED' as const) : ('EXISTS' as const), purge };
    }),

  // Unfinished purges no sweep is working on now.
  findPurgesToRun: async (now: Date): Promise<string[]> =>
    (
      await prisma.eventMediaPurge.findMany({
        where: { completedAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        select: { id: true },
        orderBy: { startedAt: 'asc' },
      })
    ).map((p) => p.id),

  // Takes the purge for one attempt, or false when it is finished or
  // another sweep holds it: a conditional write, so of two sweeps racing
  // exactly one gets it.
  takeLease: async (purgeId: string, now: Date, leaseUntil: Date): Promise<boolean> => {
    const { count } = await prisma.eventMediaPurge.updateMany({
      where: { id: purgeId, completedAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { leaseUntil, attemptCount: { increment: 1 }, lastAttemptAt: now },
    });
    return count === 1;
  },

  findPurge: (purgeId: string) =>
    prisma.eventMediaPurge.findUniqueOrThrow({
      where: { id: purgeId },
      include: { event: { select: { tenantId: true } } },
    }),

  // Every item of the event's hub (any status, archived or not: each has a
  // file) that existed when the purge began and isn't purged yet. An item
  // uploaded after a restore is never part of an older purge.
  findItemsToPurge: (eventId: string, startedAt: Date) =>
    prisma.memoryItem.findMany({
      where: { memoryHub: { eventId }, purgedAt: null, createdAt: { lte: startedAt } },
      select: { id: true, cloudinaryPublicId: true, mediaType: true },
      orderBy: { createdAt: 'asc' },
    }),

  // Purged, and archived too, so every live-items query leaves it out.
  markItemsPurged: (itemIds: string[], now: Date, actor: string) =>
    itemIds.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.memoryItem.updateMany({
          where: { id: { in: itemIds }, purgedAt: null },
          data: { purgedAt: now, isArchived: true, updatedBy: actor },
        }),

  // Ends an attempt and releases the lease: complete when nothing failed,
  // else left for the next sweep with what failed and why.
  finishAttempt: (purgeId: string, result: { purgedCount: number; failedCount: number; lastError: string | null; completedAt: Date | null }) =>
    prisma.eventMediaPurge.update({
      where: { id: purgeId },
      data: {
        leaseUntil: null,
        purgedCount: { increment: result.purgedCount },
        failedCount: result.failedCount,
        lastError: result.lastError,
        completedAt: result.completedAt,
      },
    }),

  findPurgeForEvent: (eventId: string, archivedAt: Date) =>
    prisma.eventMediaPurge.findUnique({ where: { eventId_archivedAt: { eventId, archivedAt } } }),
};
