import { type CheckInPassKind, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { GUEST_NOT_AWAITING_APPROVAL, INVITE_TOKEN_USABLE } from '../registration-approval/registration-approval-gate.util.js';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  CHECK-IN PASSES — queries only. What a pass should exist for, and when
//  one is revoked, is check-in-pass.service.ts's and check-in-pass-kinds.ts's.
// ─────────────────────────────────────────

const personSelect = { id: true, firstName: true, surname: true } as const;

// Everything an RSVP party's passes are decided from, in one read: the guest
// who RSVP'd, their live invites' answers per day, their live plus-ones and
// theirs, and the event's live days with each one's venue type.
const partySelect = {
  id: true,
  eventId: true,
  firstName: true,
  surname: true,
  isArchived: true,
  pendingApproval: true,
  registrationDeclinedAt: true,
  invites: {
    where: { isArchived: false },
    select: { status: true, attendances: { select: { eventDayId: true } } },
  },
  plusOnes: {
    where: { isArchived: false, ...GUEST_NOT_AWAITING_APPROVAL },
    select: {
      ...personSelect,
      invites: {
        where: { isArchived: false },
        select: { status: true, attendances: { select: { eventDayId: true } } },
      },
    },
  },
  event: {
    select: {
      id: true,
      status: true,
      isArchived: true,
      eventDays: {
        where: { isArchived: false },
        select: { id: true, label: true, date: true, startTime: true, endTime: true, locationType: true },
      },
    },
  },
} satisfies Prisma.GuestSelect;

export type RsvpParty = Prisma.GuestGetPayload<{ select: typeof partySelect }>;

const passSelect = {
  id: true,
  eventId: true,
  eventDayId: true,
  guestId: true,
  plusOneGuestId: true,
  kind: true,
  status: true,
} satisfies Prisma.CheckInPassSelect;

export type PassRow = Prisma.CheckInPassGetPayload<{ select: typeof passSelect }>;

export interface NewPass {
  eventId: string;
  eventDayId: string;
  guestId: string;
  plusOneGuestId: string | null;
  kind: CheckInPassKind;
}

export const checkInPassRepository = {
  // Who RSVP'd for a party (the guest, or the host of a plus-one), and
  // their event.
  findPartyHead: async (guestId: string): Promise<{ partyGuestId: string; eventId: string } | null> => {
    const guest = await prisma.guest.findUnique({ where: { id: guestId }, select: { id: true, eventId: true, hostGuestId: true } });
    return guest ? { partyGuestId: guest.hostGuestId ?? guest.id, eventId: guest.eventId } : null;
  },

  // Serialises every reconcile of one party: a second request waits here
  // until the first has committed, then reads what it wrote.
  lockParty: (tx: Prisma.TransactionClient, guestId: string) =>
    tx.$queryRaw`SELECT "id" FROM "Guest" WHERE "id" = ${guestId} FOR UPDATE`,

  findParty: (guestId: string) =>
    prisma.guest.findUnique({ where: { id: guestId }, select: partySelect }),

  // The same party, read inside the reconcile's transaction under the lock,
  // as flat queries one after another. A nested select inside an interactive
  // transaction makes Prisma load the relations in parallel on the
  // transaction's one connection (its query interpreter's join, Promise.all),
  // which pg 8.23 deprecates ("client.query() when the client is already
  // executing a query"). The event and its days come from the caller: the
  // lock serialises the party's own rows, not the organiser's edits.
  findPartyLocked: async (
    tx: Prisma.TransactionClient,
    guestId: string,
    event: RsvpParty['event']
  ): Promise<RsvpParty | null> => {
    const guest = await tx.guest.findUnique({
      where: { id: guestId },
      select: { id: true, eventId: true, firstName: true, surname: true, isArchived: true, pendingApproval: true, registrationDeclinedAt: true },
    });
    if (!guest) return null;
    const plusOnes = await tx.guest.findMany({
      where: { hostGuestId: guestId, isArchived: false, ...GUEST_NOT_AWAITING_APPROVAL },
      select: personSelect,
    });
    const invites = await tx.invite.findMany({
      where: { guestId: { in: [guest.id, ...plusOnes.map((p) => p.id)] }, isArchived: false },
      select: { id: true, guestId: true, status: true },
    });
    const attendances = invites.length
      ? await tx.attendance.findMany({ where: { inviteId: { in: invites.map((i) => i.id) } }, select: { inviteId: true, eventDayId: true } })
      : [];
    const invitesOf = (personId: string) =>
      invites
        .filter((i) => i.guestId === personId)
        .map((i) => ({ status: i.status, attendances: attendances.filter((a) => a.inviteId === i.id).map((a) => ({ eventDayId: a.eventDayId })) }));
    return {
      ...guest,
      invites: invitesOf(guest.id),
      plusOnes: plusOnes.map((p) => ({ ...p, invites: invitesOf(p.id) })),
      event,
    };
  },

  // The event's plan inputs (effective-plan.util.ts's resolveEventPlan).
  findEventForPlan: (eventId: string) =>
    prisma.event.findUnique({
      where: { id: eventId },
      select: { tenantId: true, eventPass: true, eventDays: { where: { isArchived: false } }, grantedTier: true, grantedCustomTierId: true },
    }),

  findActiveForParty: (guestId: string, db: Db = prisma) =>
    db.checkInPass.findMany({ where: { guestId, status: 'ACTIVE' }, select: passSelect }),

  // Conditional on still being ACTIVE, so revoking twice is harmless.
  revoke: (ids: string[], reason: string, db: Db = prisma) =>
    db.checkInPass.updateMany({
      where: { id: { in: ids }, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason },
    }),

  // ON CONFLICT DO NOTHING against the one-active-per-person-per-day index:
  // a pass another request issued first is kept, never duplicated.
  createMissing: (passes: NewPass[], db: Db = prisma) =>
    passes.length ? db.checkInPass.createMany({ data: passes, skipDuplicates: true }) : Promise.resolve({ count: 0 }),

  findById: (id: string) => prisma.checkInPass.findUnique({ where: { id }, select: { ...passSelect, revokedAt: true } }),

  // REPLACED (check-in-scan.service.ts): active passes of a party for a day,
  // the guest's own (plusOneGuestId null), one plus-one's, or every
  // plus-one's.
  countActiveForDay: (guestId: string, eventDayId: string, plusOne: 'GUEST' | 'ANY_PLUS_ONE' | string) =>
    prisma.checkInPass.count({
      where: {
        guestId,
        eventDayId,
        status: 'ACTIVE',
        plusOneGuestId: plusOne === 'GUEST' ? null : plusOne === 'ANY_PLUS_ONE' ? { not: null } : plusOne,
      },
    }),

  // The party's plus-one passes for a day revoked in the same reconcile as
  // one of them (one updateMany writes one revokedAt for all).
  countPlusOnesRevokedTogether: (guestId: string, eventDayId: string, revokedAt: Date) =>
    prisma.checkInPass.count({ where: { guestId, eventDayId, status: 'REVOKED', revokedAt, plusOneGuestId: { not: null } } }),

  // The guest's page: the invite behind a token, exactly when the token
  // still opens the invitation (removed, pending or declined registrations
  // and archived invites are null, like an unknown token).
  findInviteForPasses: (token: string) =>
    prisma.invite.findUnique({
      where: { token, ...INVITE_TOKEN_USABLE },
      select: {
        guestId: true,
        eventId: true,
        guest: { select: { hostGuestId: true } },
        event: { select: { isArchived: true, status: true, eventDays: { select: { date: true, startTime: true, endTime: true } } } },
      },
    }),

  // A party's active passes with what the page shows, earliest day first.
  // `onlyPerson` narrows to one plus-one's own passes.
  findActiveForPage: (guestId: string, onlyPlusOneGuestId: string | null) =>
    prisma.checkInPass.findMany({
      where: { guestId, status: 'ACTIVE', ...(onlyPlusOneGuestId ? { plusOneGuestId: onlyPlusOneGuestId } : {}) },
      select: {
        id: true,
        kind: true,
        plusOneGuestId: true,
        guest: { select: { firstName: true, surname: true } },
        plusOneGuest: { select: { firstName: true, surname: true } },
        eventDay: { select: { id: true, label: true, date: true, startTime: true } },
        createdAt: true,
      },
      orderBy: [{ eventDay: { date: 'asc' } }, { createdAt: 'asc' }],
    }),

  findDay: (eventDayId: string) =>
    prisma.eventDay.findUnique({ where: { id: eventDayId }, select: { id: true, label: true, date: true } }),

  findUserName: (userId: string) => prisma.user.findUnique({ where: { id: userId }, select: { username: true } }),
};
