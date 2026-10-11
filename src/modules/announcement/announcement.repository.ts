import prisma from '../../shared/prisma/prisma.client.js';
import { type AnnouncementAudience, type AnnouncementKind, type Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
const db = (tx?: Tx) => tx ?? prisma;

export interface CreateAnnouncementInput {
  eventId: string;
  kind: AnnouncementKind;
  subject: string;
  body: string | null;
  audience: AnnouncementAudience;
  eventDayId: string | null;
  sentBy: string;
  recipientCount: number;
  unreachableCount: number;
}

// Append-only (schema.prisma): create methods only. There is deliberately
// no update or delete here.
export const announcementRepository = {
  // Every live, primary guest of the event with their live invites (newest
  // first) and each invite's live days. One query; announcement-audience
  // .util.ts decides who is in an audience.
  findAudienceGuests: (eventId: string) =>
    prisma.guest.findMany({
      where: { eventId, isArchived: false, hostGuestId: null },
      select: {
        id: true,
        firstName: true,
        surname: true,
        email: true,
        phoneNumber: true,
        selfRegisteredAt: true,
        invites: {
          where: { isArchived: false },
          orderBy: { createdAt: 'desc' },
          select: {
            token: true,
            status: true,
            deliveredAt: true,
            inviteEventDay: { where: { eventDay: { isArchived: false } }, select: { eventDayId: true } },
            attendances: { where: { eventDay: { isArchived: false } }, select: { eventDayId: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),

  // Serialises announcement claims for one event, so the daily limit is
  // counted and claimed with no other claim committing in between. Same
  // row-lock idiom as event-public.repository.ts's
  // withEventRegistrationLock. Returns the event's status as read under
  // the lock, so a send can't claim on an event cancelled a moment ago.
  withEventAnnouncementLock: <T>(eventId: string, fn: (tx: Tx, status: string) => Promise<T>): Promise<T> =>
    prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
        return fn(tx, rows[0]?.status ?? '');
      },
      { maxWait: 10_000, timeout: 15_000 }
    ),

  // The organiser's announcements (never the cancellation email) sent at or
  // after `since`, oldest first: the daily limit counts them, and the
  // oldest says when the next one can be sent.
  findSentSince: (eventId: string, since: Date, tx?: Tx) =>
    db(tx).announcement.findMany({
      where: { eventId, kind: 'ANNOUNCEMENT', sentAt: { gte: since } },
      orderBy: { sentAt: 'asc' },
      select: { sentAt: true },
    }),

  create: (data: CreateAnnouncementInput, tx?: Tx) => db(tx).announcement.create({ data }),

  createDeliveries: (rows: { announcementId: string; guestId: string; succeeded: boolean; failureReason: string | null }[]) =>
    rows.length ? prisma.announcementDelivery.createMany({ data: rows }) : Promise.resolve({ count: 0 }),

  // Newest first.
  findAllForEvent: (eventId: string) =>
    prisma.announcement.findMany({
      where: { eventId },
      orderBy: { sentAt: 'desc' },
      include: { eventDay: { select: { label: true } } },
    }),

  // How many of each announcement's emails went and how many failed, from
  // the delivery rows (one query for the whole event).
  countDeliveriesForEvent: async (eventId: string) => {
    const groups = await prisma.announcementDelivery.groupBy({
      by: ['announcementId', 'succeeded'],
      where: { announcement: { eventId } },
      _count: { _all: true },
    });
    const counts = new Map<string, { sent: number; failed: number }>();
    for (const g of groups) {
      const c = counts.get(g.announcementId) ?? { sent: 0, failed: 0 };
      if (g.succeeded) c.sent = g._count._all;
      else c.failed = g._count._all;
      counts.set(g.announcementId, c);
    }
    return counts;
  },

};
