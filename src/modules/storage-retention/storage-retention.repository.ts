import { Prisma, type DocumentRetentionReason } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { EVENT_ORGANISERS_SELECT } from '../event-assignment/event-organisers.util.js';

// Prisma queries only; the rules are storage-retention.service.ts's.

type Tx = Prisma.TransactionClient;

// A cutoff for raw SQL against a TIMESTAMP (no time zone) column, which
// holds UTC: the ISO string cast to timestamp (media-retention.repository.ts).
const utcTimestamp = (date: Date): string => date.toISOString();

const LIVE_DOCUMENT = { deleteRequestedAt: null, deletedAt: null } as const;

// The end of an event's last live day, as resolveEffectiveStatus counts it
// (event-status.util.ts's eventFinishesAt): its endTime, else the end of
// its date (UTC).
const LAST_DAY_END_SQL = Prisma.sql`(
  SELECT COALESCE(d."endTime", d."date" + interval '1 day' - interval '1 millisecond')
  FROM "EventDay" d
  WHERE d."eventId" = e."id" AND d."isArchived" = false
  ORDER BY d."date" DESC
  LIMIT 1
)`;

// When each rule's clock started: the finish for FINISHED and
// ARCHIVED_AT_FINISH (published events only), cancelledAt for CANCELLED.
const clockStartedBy = (reason: DocumentRetentionReason, cutoff: Date): Prisma.Sql =>
  reason === 'CANCELLED'
    ? Prisma.sql`e."status" = 'CANCELLED'::"EventStatus" AND e."cancelledAt" IS NOT NULL AND e."cancelledAt" <= ${utcTimestamp(cutoff)}::timestamp`
    : Prisma.sql`e."status" = 'PUBLISHED'::"EventStatus" AND ${LAST_DAY_END_SQL} <= ${utcTimestamp(cutoff)}::timestamp`;

const notClaimed = (table: 'EventDocumentPurge' | 'DocumentPurgeReminderClaim', reason: DocumentRetentionReason): Prisma.Sql =>
  Prisma.sql`NOT EXISTS (SELECT 1 FROM ${Prisma.raw(`"${table}"`)} c WHERE c."eventId" = e."id" AND c."reason" = ${reason}::"DocumentRetentionReason")`;

// Documents still kept; with `archivedOwner`, only those whose guest,
// invite or question is archived.
const hasLiveDocuments = (archivedOwner: boolean): Prisma.Sql => Prisma.sql`EXISTS (
  SELECT 1 FROM "GuestDocument" g
  ${archivedOwner
    ? Prisma.sql`LEFT JOIN "Invite" i ON i."id" = g."inviteId" LEFT JOIN "Guest" gu ON gu."id" = i."guestId" JOIN "RsvpField" f ON f."id" = g."rsvpFieldId"`
    : Prisma.empty}
  WHERE g."eventId" = e."id" AND g."deleteRequestedAt" IS NULL AND g."deletedAt" IS NULL
  ${archivedOwner ? Prisma.sql`AND (i."isArchived" = true OR gu."isArchived" = true OR f."isArchived" = true)` : Prisma.empty}
)`;

export const storageRetentionRepository = {

  withTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => prisma.$transaction(fn, { maxWait: 10_000, timeout: 30_000 }),

  // ── Memory Hub items ─────────────────────

  // The live-condition of the 7-day rule: rejected at or before the cutoff,
  // or removed at or before it. Re-checked by the claim's own UPDATE.
  itemsDueWhere: (cutoff: Date): Prisma.MemoryItemWhereInput => ({
    purgedAt: null,
    OR: [
      { status: 'REJECTED', rejectedAt: { lte: cutoff } },
      { isArchived: true, removedAt: { lte: cutoff } },
    ],
  }),

  findItemsDue: (where: Prisma.MemoryItemWhereInput, take: number) =>
    prisma.memoryItem.findMany({
      where,
      select: {
        id: true,
        cloudinaryPublicId: true,
        memoryHub: { select: { eventId: true, event: { select: { tenantId: true } } } },
      },
      orderBy: { id: 'asc' },
      take,
    }),

  // ── Documents: which events are due ───────

  // Events whose rule is due by `cutoff`, not yet claimed, with documents
  // to delete. ARCHIVED_AT_FINISH: finished, with documents of an archived
  // guest, invite or question. FINISHED / CANCELLED (no reminder needed:
  // these are the reminder's candidates): any kept document.
  findEventsDue: async (reason: DocumentRetentionReason, cutoff: Date): Promise<string[]> =>
    (await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "Event" e
      WHERE ${clockStartedBy(reason, cutoff)}
        AND ${notClaimed('EventDocumentPurge', reason)}
        AND ${hasLiveDocuments(reason === 'ARCHIVED_AT_FINISH')}
      ORDER BY e."id"
    `).map((r) => r.id),

  // Reminder candidates: due by remindFrom, never reminded, never purged,
  // with documents to delete.
  findReminderCandidates: async (reason: DocumentRetentionReason, remindFrom: Date): Promise<string[]> =>
    (await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "Event" e
      WHERE ${clockStartedBy(reason, remindFrom)}
        AND ${notClaimed('DocumentPurgeReminderClaim', reason)}
        AND ${notClaimed('EventDocumentPurge', reason)}
        AND ${hasLiveDocuments(false)}
      ORDER BY e."id"
    `).map((r) => r.id),

  // Purges due: the N days up (purgeFrom), reminded at or before
  // remindedBy (a full week ago), not yet claimed. An event whose reminder
  // is late waits for it.
  findPurgesDue: async (reason: DocumentRetentionReason, purgeFrom: Date, remindedBy: Date): Promise<string[]> =>
    (await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "Event" e
      WHERE ${clockStartedBy(reason, purgeFrom)}
        AND ${notClaimed('EventDocumentPurge', reason)}
        AND EXISTS (
          SELECT 1 FROM "DocumentPurgeReminderClaim" r
          WHERE r."eventId" = e."id" AND r."reason" = ${reason}::"DocumentRetentionReason"
            AND r."claimedAt" <= ${utcTimestamp(remindedBy)}::timestamp
        )
      ORDER BY e."id"
    `).map((r) => r.id),

  // ── Documents: one event ─────────────────

  // What the claims and the reminder re-check, and whom it emails.
  findEvent: (eventId: string, db: Tx | typeof prisma = prisma) =>
    db.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        status: true,
        cancelledAt: true,
        eventDays: { where: { isArchived: false }, select: { date: true, endTime: true } },
        ...EVENT_ORGANISERS_SELECT,
      },
    }),

  lockEvent: async (tx: Tx, eventId: string): Promise<void> => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  },

  countLiveDocuments: (eventId: string) => prisma.guestDocument.count({ where: { eventId, ...LIVE_DOCUMENT } }),

  // The claim: one row per event and rule (the unique index). False when
  // another sweep claimed it first.
  claimPurge: async (tx: Tx, eventId: string, reason: DocumentRetentionReason, now: Date): Promise<boolean> =>
    (await tx.eventDocumentPurge.createMany({ data: [{ eventId, reason, claimedAt: now }], skipDuplicates: true })).count === 1,

  recordRequested: (tx: Tx, eventId: string, reason: DocumentRetentionReason, requestedCount: number) =>
    tx.eventDocumentPurge.update({ where: { eventId_reason: { eventId, reason } }, data: { requestedCount } }),

  claimReminder: async (eventId: string, reason: DocumentRetentionReason, recipientCount: number, claimedAt: Date): Promise<boolean> =>
    (await prisma.documentPurgeReminderClaim.createMany({
      data: [{ eventId, reason, recipientCount, claimedAt }],
      skipDuplicates: true,
    })).count === 1,

  // The event's claims, for its countdown.
  findClaims: async (eventId: string) => {
    const [purges, reminders] = await Promise.all([
      prisma.eventDocumentPurge.findMany({ where: { eventId }, select: { reason: true, claimedAt: true } }),
      prisma.documentPurgeReminderClaim.findMany({ where: { eventId }, select: { reason: true, claimedAt: true } }),
    ]);
    return { purges, reminders };
  },
};

// The documents of an event whose guest, invite or question is archived:
// what ARCHIVED_AT_FINISH deletes. Checked again by the request's own write.
export const archivedOwnerDocumentsWhere = (eventId: string): Prisma.GuestDocumentWhereInput => ({
  eventId,
  OR: [
    { invite: { is: { isArchived: true } } },
    { invite: { is: { guest: { isArchived: true } } } },
    { rsvpField: { isArchived: true } },
  ],
});
