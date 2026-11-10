import { Prisma, type EventEmailKind } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;

// What the worker gets for each email it claims.
export interface ClaimedEmailItem {
  id: string;
  sendId: string;
  eventId: string;
  kind: EventEmailKind;
  inviteId: string;
  attempts: number;
  leaseUntil: Date;
  remindedAt: Date | null;
  previousRemindedAt: Date | null;
}

export interface NewEmailItem {
  inviteId: string;
  remindedAt?: Date | null;
  previousRemindedAt?: Date | null;
}

const ERROR_MAX_LENGTH = 500;

export const emailSendRepository = {
  // ── Queueing (inside the event's email lock) ──────────────────────────

  // Which of these invites already have this email waiting or going out,
  // or sent at or after `sentSince`: the duplicate check before queueing.
  findBlocking: (tx: Tx, inviteIds: string[], kind: EventEmailKind, sentSince: Date) =>
    tx.emailSendItem.findMany({
      where: {
        inviteId: { in: inviteIds },
        kind,
        OR: [{ status: { in: ['QUEUED', 'SENDING'] } }, { status: 'SENT', sentAt: { gte: sentSince } }],
      },
      select: { inviteId: true, sendId: true, status: true, sentAt: true },
    }),

  createSend: (tx: Tx, data: { eventId: string; kind: EventEmailKind; createdBy: string }) =>
    tx.emailSend.create({ data, select: { id: true } }),

  // skipDuplicates: ON CONFLICT DO NOTHING, so the partial unique index
  // ("EmailSendItem_pending_invite_kind_key") turns a second waiting copy of
  // the same email into no row. Returns the rows actually written.
  createItems: (tx: Tx, send: { id: string; eventId: string; kind: EventEmailKind }, items: NewEmailItem[]) =>
    tx.emailSendItem.createManyAndReturn({
      data: items.map((item) => ({
        sendId: send.id,
        eventId: send.eventId,
        kind: send.kind,
        inviteId: item.inviteId,
        remindedAt: item.remindedAt ?? null,
        previousRemindedAt: item.previousRemindedAt ?? null,
      })),
      skipDuplicates: true,
      select: { inviteId: true },
    }),

  // ── The worker ────────────────────────────────────────────────────────

  // Takes up to `limit` due emails in one statement: QUEUED ones whose
  // time has come, and SENDING ones whose lease ran out (a worker that
  // died mid-send). SKIP LOCKED, so any number of workers on any number of
  // servers never take the same email. Each take counts as an attempt.
  //
  // The due rows are picked in a MATERIALIZED CTE, which runs once. Not
  // `UPDATE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`:
  // on a plan that runs that subquery once per outer row (a nested-loop
  // semi join, which stale statistics on a new or emptied table invite),
  // each run skips the rows the UPDATE already changed and returns the next
  // ones; it took 24 for a limit of 20 on this new table, and all 60 due
  // rows in a test that pins the plan (tests/storage/claim-limits.test.ts).
  //
  // `eventId` limits it to one event: only tests use it, since the test
  // database holds every test file's queue. `db`: a transaction (that test).
  claimDue: (now: Date, leaseUntil: Date, limit: number, eventId?: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<ClaimedEmailItem[]> =>
    db.$queryRaw<ClaimedEmailItem[]>`
      WITH due AS MATERIALIZED (
        SELECT i."id" FROM "EmailSendItem" i
        WHERE ((i."status" = 'QUEUED' AND i."nextAttemptAt" <= ${now})
           OR (i."status" = 'SENDING' AND i."leaseUntil" < ${now}))
          ${eventId ? Prisma.sql`AND i."eventId" = ${eventId}` : Prisma.empty}
        ORDER BY i."nextAttemptAt" ASC, i."createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "EmailSendItem" AS e SET "status" = 'SENDING', "leaseUntil" = ${leaseUntil}, "attempts" = e."attempts" + 1
      FROM due WHERE e."id" = due."id"
      RETURNING e."id", e."sendId", e."eventId", e."kind", e."inviteId", e."attempts", e."leaseUntil", e."remindedAt", e."previousRemindedAt"`,

  // What the worker needs to build each email and decide whether it still
  // should go: the invite, its guest and live days, and its event.
  findInvitesForItems: (inviteIds: string[]) =>
    prisma.invite.findMany({
      where: { id: { in: inviteIds } },
      include: {
        guest: true,
        inviteEventDay: { where: { eventDay: { isArchived: false } }, include: { eventDay: true } },
        event: { include: { eventDays: { where: { isArchived: false } } } },
      },
    }),

  findSends: (sendIds: string[]) =>
    prisma.emailSend.findMany({ where: { id: { in: sendIds } }, select: { id: true, createdBy: true } }),

  // Every outcome write is guarded by the lease this worker took: if the
  // lease ran out and another worker took the email, this one's word on it
  // no longer counts. Returns whether it applied.
  markSent: async (tx: Tx, item: ClaimedEmailItem, now: Date): Promise<boolean> => {
    const { count } = await tx.emailSendItem.updateMany({
      where: { id: item.id, status: 'SENDING', leaseUntil: item.leaseUntil },
      data: { status: 'SENT', sentAt: now, leaseUntil: null, lastError: null },
    });
    return count === 1;
  },

  markRetry: async (item: ClaimedEmailItem, nextAttemptAt: Date, reason: string): Promise<boolean> => {
    const { count } = await prisma.emailSendItem.updateMany({
      where: { id: item.id, status: 'SENDING', leaseUntil: item.leaseUntil },
      data: { status: 'QUEUED', nextAttemptAt, leaseUntil: null, lastError: reason.slice(0, ERROR_MAX_LENGTH) },
    });
    return count === 1;
  },

  // FAILED (it couldn't be sent) or SKIPPED (no longer needed).
  markFinished: async (tx: Tx, item: ClaimedEmailItem, status: 'FAILED' | 'SKIPPED', reason: string, now: Date): Promise<boolean> => {
    const { count } = await tx.emailSendItem.updateMany({
      where: { id: item.id, status: 'SENDING', leaseUntil: item.leaseUntil },
      data: { status, finishedAt: now, leaseUntil: null, lastError: reason.slice(0, ERROR_MAX_LENGTH) },
    });
    return count === 1;
  },

  // ── Progress ──────────────────────────────────────────────────────────

  findSendForEvent: (sendId: string, eventId: string) =>
    prisma.emailSend.findFirst({ where: { id: sendId, eventId }, select: { id: true, kind: true, createdAt: true } }),

  countByStatus: (sendId: string) =>
    prisma.emailSendItem.groupBy({ by: ['status'], where: { sendId }, _count: { _all: true } }),

  // The ones that didn't go, with who they were for.
  findUnsent: (sendId: string) =>
    prisma.emailSendItem.findMany({
      where: { sendId, status: { in: ['FAILED', 'SKIPPED'] } },
      orderBy: { createdAt: 'asc' },
      select: {
        status: true,
        lastError: true,
        invite: { select: { guestId: true, guest: { select: { firstName: true, surname: true, email: true } } } },
      },
    }),

  latestFinishedAt: (sendId: string) =>
    prisma.emailSendItem.aggregate({ where: { sendId }, _max: { sentAt: true, finishedAt: true } }),
};

