import { Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

// What the worker gets for each schedule it claims.
export interface ClaimedSchedule {
  id: string;
  eventId: string;
  createdBy: string;
  attempts: number;
  leaseUntil: Date;
}

export interface ScheduleOutcomeCounts {
  queuedCount?: number | null;
  skippedRecentlyReminded?: number | null;
  skippedOther?: number | null;
}

const MESSAGE_MAX_LENGTH = 1000;

export const reminderScheduleRepository = {
  // ── The organiser's routes ────────────────────────────────────────────

  // SCHEDULED or SENDING: what counts toward the per-event maximum.
  countActive: (tx: Tx, eventId: string) =>
    tx.reminderSchedule.count({ where: { eventId, status: { in: ['SCHEDULED', 'SENDING'] } } }),

  create: (tx: Tx, data: { eventId: string; sendAt: Date; preset: string; createdBy: string }) =>
    tx.reminderSchedule.create({ data }),

  listForEvent: (eventId: string) =>
    prisma.reminderSchedule.findMany({ where: { eventId }, orderBy: [{ sendAt: 'asc' }, { createdAt: 'asc' }] }),

  findForEvent: (id: string, eventId: string) => prisma.reminderSchedule.findFirst({ where: { id, eventId } }),

  // Only one still waiting: one a worker has taken (SENDING) is no longer
  // cancellable. Returns whether it cancelled.
  cancel: async (id: string, eventId: string, cancelledBy: string, now: Date): Promise<boolean> => {
    const { count } = await prisma.reminderSchedule.updateMany({
      where: { id, eventId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledBy },
    });
    return count === 1;
  },

  // How each SENT schedule's emails went, from the send's own items.
  deliveryCounts: (sendIds: string[]) =>
    sendIds.length
      ? prisma.emailSendItem.groupBy({ by: ['sendId', 'status'], where: { sendId: { in: sendIds } }, _count: { _all: true } })
      : Promise.resolve([]),

  // ── The worker ────────────────────────────────────────────────────────

  // Takes up to `limit` due schedules in one statement: SCHEDULED ones whose
  // time has come, and SENDING ones whose lease ran out (a worker that died
  // mid-way). SKIP LOCKED, so two workers on two servers never take the
  // same one. The due rows are picked in a MATERIALIZED CTE, never
  // `IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` (STEERING, "Claim
  // queries"). `eventId`: tests only.
  claimDue: (now: Date, leaseUntil: Date, limit: number, eventId?: string): Promise<ClaimedSchedule[]> =>
    prisma.$queryRaw<ClaimedSchedule[]>`
      WITH due AS MATERIALIZED (
        SELECT s."id" FROM "ReminderSchedule" s
        WHERE ((s."status" = 'SCHEDULED' AND s."sendAt" <= ${now})
           OR (s."status" = 'SENDING' AND s."leaseUntil" < ${now}))
          ${eventId ? Prisma.sql`AND s."eventId" = ${eventId}` : Prisma.empty}
        ORDER BY s."sendAt" ASC, s."createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "ReminderSchedule" AS r SET "status" = 'SENDING', "leaseUntil" = ${leaseUntil}, "attempts" = r."attempts" + 1
      FROM due WHERE r."id" = due."id"
      RETURNING r."id", r."eventId", r."createdBy", r."attempts", r."leaseUntil"`,

  // The event as the worker judges it: stored status, live days.
  findEventForWorker: (eventId: string) =>
    prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        status: true,
        visibility: true,
        isArchived: true,
        rsvpDeadline: true,
        eventDays: { where: { isArchived: false }, select: { date: true, startTime: true, endTime: true } },
      },
    }),

  // Is this still the worker's to finish? A cheap early check inside the
  // queueing transaction; markSent's guard is what settles it.
  holdsLease: async (tx: Tx, item: ClaimedSchedule): Promise<boolean> =>
    (await tx.reminderSchedule.count({ where: { id: item.id, status: 'SENDING', leaseUntil: item.leaseUntil } })) === 1,

  // Every outcome is guarded by the lease the worker took: if it ran out
  // and another worker took the schedule, this one's word no longer counts.
  markSent: async (tx: Tx, item: ClaimedSchedule, emailSendId: string, counts: ScheduleOutcomeCounts, now: Date): Promise<boolean> => {
    const { count } = await tx.reminderSchedule.updateMany({
      where: { id: item.id, status: 'SENDING', leaseUntil: item.leaseUntil },
      data: { status: 'SENT', emailSendId, processedAt: now, leaseUntil: null, ...counts },
    });
    return count === 1;
  },

  markSkipped: async (
    item: ClaimedSchedule,
    skipReason: string,
    skipMessage: string,
    counts: ScheduleOutcomeCounts,
    now: Date,
    db: Db = prisma
  ): Promise<boolean> => {
    const { count } = await db.reminderSchedule.updateMany({
      where: { id: item.id, status: 'SENDING', leaseUntil: item.leaseUntil },
      data: { status: 'SKIPPED', skipReason, skipMessage: skipMessage.slice(0, MESSAGE_MAX_LENGTH), processedAt: now, leaseUntil: null, ...counts },
    });
    return count === 1;
  },
};
