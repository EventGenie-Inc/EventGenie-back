import { Prisma, type InviteStatus, type PlatformRole } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { type ConsoleEventStatus } from './admin-console.types.js';

// ─────────────────────────────────────────
//  THE SUPER ADMIN CONSOLE's reads (STEERING "Super admin console"). Read
//  only: nothing here writes. The internal e-velope organisation (its
//  templates) is left out of every one.
// ─────────────────────────────────────────

// Any event but a template (the internal organisation's).
const NOT_TEMPLATE: Prisma.EventWhereInput = { tenant: { isInternal: false } };

const utcMidnight = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// A live day that hasn't ended: its endTime still ahead, or with none, its
// date today or later. event-status.util.ts's rule (a day without an
// endTime ends at the end of its UTC date), as a query.
const unfinishedDay = (now: Date): Prisma.EventDayWhereInput => ({
  isArchived: false,
  OR: [{ endTime: { gte: now } }, { endTime: null, date: { gte: utcMidnight(now) } }],
});

// The console's status as a query. ARCHIVED is any deleted event; the others
// are live (not archived) events by their effective status: a published
// event is FINISHED once all of its days have ended (resolveEffectiveStatus),
// LIVE while one hasn't or it has none.
export const consoleStatusWhere = (status: ConsoleEventStatus, now: Date): Prisma.EventWhereInput => {
  switch (status) {
    case 'ARCHIVED':
      return { isArchived: true };
    case 'DRAFT':
      return { isArchived: false, status: 'DRAFT' };
    case 'CANCELLED':
      return { isArchived: false, status: 'CANCELLED' };
    case 'LIVE':
      return {
        isArchived: false,
        status: 'PUBLISHED',
        OR: [{ eventDays: { none: { isArchived: false } } }, { eventDays: { some: unfinishedDay(now) } }],
      };
    case 'FINISHED':
      return { isArchived: false, status: 'PUBLISHED', eventDays: { some: { isArchived: false }, none: unfinishedDay(now) } };
  }
};

// Every word must match one of the fields (any order, any case).
const searchWhere = <W>(terms: string[], fields: string[]): W[] =>
  terms.map((term) => ({ OR: fields.map((f) => ({ [f]: { contains: term, mode: 'insensitive' } })) }) as W);

export interface EventFilters {
  terms: string[];
  tenantId: string | null;
  status: ConsoleEventStatus | null;
  // A live day's date within [from, to] (UTC dates, either may be open).
  from: Date | null;
  to: Date | null;
}

const eventsWhere = (f: EventFilters, now: Date): Prisma.EventWhereInput => ({
  AND: [
    NOT_TEMPLATE,
    ...(f.tenantId ? [{ tenantId: f.tenantId }] : []),
    ...(f.status ? [consoleStatusWhere(f.status, now)] : []),
    ...f.terms.map((term) => ({ name: { contains: term, mode: 'insensitive' as const } })),
    ...(f.from || f.to
      ? [{ eventDays: { some: { isArchived: false, date: { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) } } } }]
      : []),
  ],
});

// What the list and the detail read of an event: enough for its status, its
// plan's name (the tenant's plan state, its Event Pass, its grant) and its
// tenant's name.
const EVENT_SELECT = {
  id: true,
  name: true,
  status: true,
  isArchived: true,
  archivedAt: true,
  visibility: true,
  createdAt: true,
  tenantId: true,
  grantedTier: true,
  grantedCustomTierId: true,
  eventPass: { select: { passTier: true } },
  eventDays: { where: { isArchived: false }, orderBy: { date: 'asc' }, select: { date: true, endTime: true } },
  tenant: {
    select: {
      id: true,
      name: true,
      subscriptionTier: true,
      subscriptionCancelAtPeriodEnd: true,
      subscriptionCurrentPeriodEnd: true,
      subscriptionGraceStartedAt: true,
      subscriptionNeedsSync: true,
      customTierId: true,
      customTierEndsAt: true,
      customTier: { select: { name: true } },
    },
  },
} as const satisfies Prisma.EventSelect;

export type ConsoleEventRow = Prisma.EventGetPayload<{ select: typeof EVENT_SELECT }>;

export interface UserFilters {
  terms: string[];
  tenantId: string | null;
  role: PlatformRole | null;
}

const usersWhere = (f: UserFilters): Prisma.UserWhereInput => ({
  AND: [
    // A super admin has no organisation; nobody should be in the internal
    // one, but anyone who is is left out with it.
    { OR: [{ tenantId: null }, { tenant: { isInternal: false } }] },
    ...(f.tenantId ? [{ tenantId: f.tenantId }] : []),
    ...(f.role ? [{ role: f.role }] : []),
    ...searchWhere<Prisma.UserWhereInput>(f.terms, ['username', 'email']),
  ],
});

export const adminConsoleRepository = {
  // The dashboard's numbers.
  countTenants: () => prisma.tenant.count({ where: { isArchived: false, isInternal: false } }),
  countEvents: (status: ConsoleEventStatus | null, now: Date) =>
    prisma.event.count({ where: status ? { AND: [NOT_TEMPLATE, consoleStatusWhere(status, now)] } : NOT_TEMPLATE }),
  countGuests: () => prisma.guest.count({ where: { isArchived: false, event: NOT_TEMPLATE } }),

  // Users, newest first.
  findUsers: async (f: UserFilters, skip: number, take: number) => {
    const where = usersWhere(f);
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          isActive: true,
          isArchived: true,
          createdAt: true,
          tenant: { select: { id: true, name: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);
    return { rows, total };
  },

  // When each user last signed in: a sign-in code used (verify-otp) or a
  // trusted device starting a session (the session exchange). A session
  // refresh isn't a sign-in.
  findLastSignIns: async (userIds: string[]): Promise<Map<string, Date>> => {
    const last = new Map<string, Date>();
    if (userIds.length === 0) return last;
    const [otps, devices] = await Promise.all([
      prisma.otpRecord.groupBy({ by: ['userId'], where: { userId: { in: userIds }, usedAt: { not: null } }, _max: { usedAt: true } }),
      prisma.deviceToken.groupBy({ by: ['userId'], where: { userId: { in: userIds }, lastUsedAt: { not: null } }, _max: { lastUsedAt: true } }),
    ]);
    const keep = (userId: string, at: Date | null) => {
      if (at && (!last.has(userId) || at > last.get(userId)!)) last.set(userId, at);
    };
    for (const o of otps) keep(o.userId, o._max.usedAt);
    for (const d of devices) keep(d.userId, d._max.lastUsedAt);
    return last;
  },

  // Events (never a template), newest first.
  findEvents: async (f: EventFilters, now: Date, skip: number, take: number) => {
    const where = eventsWhere(f, now);
    const [rows, total] = await Promise.all([
      prisma.event.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take, select: EVENT_SELECT }),
      prisma.event.count({ where }),
    ]);
    return { rows, total };
  },

  // One event (archived too; never a template), with its days in full.
  findEvent: (eventId: string) =>
    prisma.event.findFirst({
      where: { id: eventId, ...NOT_TEMPLATE },
      select: {
        ...EVENT_SELECT,
        description: true,
        hostName: true,
        ticketing: true,
        coverImageUrl: true,
        rsvpDeadline: true,
        capacity: true,
        updatedAt: true,
        eventGrantId: true,
        eventDays: {
          where: { isArchived: false },
          orderBy: { date: 'asc' },
          select: {
            id: true,
            label: true,
            date: true,
            startTime: true,
            endTime: true,
            locationType: true,
            location: true,
            address: true,
            onlineUrl: true,
          },
        },
      },
    }),

  // Invitation counts per event: live invitations of live guests, not
  // awaiting approval; checked in = with at least one check-in.
  countInvites: async (eventIds: string[]) => {
    const counts = new Map<string, { byStatus: Partial<Record<InviteStatus, number>>; checkedIn: number }>();
    if (eventIds.length === 0) return counts;
    for (const id of eventIds) counts.set(id, { byStatus: {}, checkedIn: 0 });
    const [byStatus, checkedIn] = await Promise.all([
      prisma.invite.groupBy({
        by: ['eventId', 'status'],
        where: { eventId: { in: eventIds }, isArchived: false, guest: { isArchived: false, pendingApproval: false } },
        _count: { _all: true },
      }),
      prisma.$queryRaw<{ eventId: string; n: bigint }[]>`
        SELECT i."eventId", COUNT(DISTINCT i."id") AS n
        FROM "Invite" i
        JOIN "Guest" g ON g."id" = i."guestId"
        JOIN "CheckIn" c ON c."inviteId" = i."id"
        WHERE i."eventId" IN (${Prisma.join(eventIds)})
          AND i."isArchived" = false AND g."isArchived" = false AND g."pendingApproval" = false
        GROUP BY i."eventId"`,
    ]);
    for (const row of byStatus) counts.get(row.eventId)!.byStatus[row.status] = row._count._all;
    for (const row of checkedIn) counts.get(row.eventId)!.checkedIn = Number(row.n);
    return counts;
  },

  countPendingApproval: (eventId: string) =>
    prisma.guest.count({ where: { eventId, isArchived: false, hostGuestId: null, pendingApproval: true } }),

  // One event's live guests, newest first, each with their live invitation's
  // answer and check-ins.
  findGuests: async (eventId: string, terms: string[], skip: number, take: number) => {
    const where: Prisma.GuestWhereInput = {
      eventId,
      isArchived: false,
      AND: searchWhere<Prisma.GuestWhereInput>(terms, ['firstName', 'surname', 'email', 'phoneNumber']),
    };
    const [rows, total] = await Promise.all([
      prisma.guest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: {
          id: true,
          firstName: true,
          surname: true,
          email: true,
          phoneNumber: true,
          hostGuestId: true,
          pendingApproval: true,
          createdAt: true,
          invites: {
            where: { isArchived: false },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, checkIns: { orderBy: { checkedInAt: 'asc' }, select: { eventDayId: true, checkedInAt: true } } },
          },
        },
      }),
      prisma.guest.count({ where }),
    ]);
    return { rows, total };
  },
};
