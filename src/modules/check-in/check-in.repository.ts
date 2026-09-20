import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';

// One shape for every read here, so a roster row always looks the same
// whether it came from the whole list or from a single guest. Attendance is
// the guest's RSVP answer for the day; CheckIn is whether they turned up —
// see the schema comments on both.
const rosterInviteSelect = (eventDayId: string) => ({
  id: true,
  guestId: true,
  status: true,
  guest: {
    select: {
      firstName: true,
      surname: true,
      email: true,
      phoneNumber: true,
      hostGuestId: true,
      hostGuest: { select: { firstName: true, surname: true } },
    },
  },
  attendances: { where: { eventDayId }, select: { id: true } },
  checkIns: { where: { eventDayId }, select: { checkedInAt: true } },
} satisfies Prisma.InviteSelect);

export type RosterInvite = Prisma.InviteGetPayload<{ select: ReturnType<typeof rosterInviteSelect> }>;

// "Invited to this day" means the invite has an InviteEventDay row for it.
// Live means neither the invite nor its guest is archived.
const liveInvitedToDay = (eventId: string, eventDayId: string): Prisma.InviteWhereInput => ({
  eventId,
  isArchived: false,
  guest: { isArchived: false },
  inviteEventDay: { some: { eventDayId } },
});

export const checkInRepository = {
  // The whole door list for a day in one query — the same shape as the
  // guest export's findAllForExport (one findMany, relations selected in
  // it, no per-guest round trips, no pagination). Newest invite first so
  // the service's one-row-per-guest rule keeps the most recent.
  findRoster: (eventId: string, eventDayId: string) =>
    prisma.invite.findMany({
      where: liveInvitedToDay(eventId, eventDayId),
      select: rosterInviteSelect(eventDayId),
      orderBy: { createdAt: 'desc' },
    }),

  // One guest's live invites for the day (usually one; an organiser can
  // create a second, so callers must not assume).
  findGuestInvites: (eventId: string, guestId: string, eventDayId: string) =>
    prisma.invite.findMany({
      where: { ...liveInvitedToDay(eventId, eventDayId), guestId },
      select: rosterInviteSelect(eventDayId),
      orderBy: { createdAt: 'desc' },
    }),

  // The QR path: resolve an invitation's token to its guest. Constrained to
  // THIS event, so a token from another event (or tenant) is simply "no
  // match", never a lookup that reaches across.
  findGuestIdByToken: (eventId: string, token: string) =>
    prisma.invite.findFirst({
      where: { eventId, token, isArchived: false, guest: { isArchived: false } },
      select: { guestId: true },
    }),

  // Used only to tell "no such guest" (404) from "exists but isn't invited to
  // that day" (422) once findGuestInvites has come back empty.
  findGuestOnEvent: (eventId: string, guestId: string) =>
    prisma.guest.findFirst({
      where: { id: guestId, eventId, isArchived: false },
      select: { firstName: true, surname: true },
    }),

  create: (inviteId: string, eventDayId: string, checkedBy: string) =>
    prisma.checkIn.create({
      data: { inviteId, eventDayId, checkedBy },
      select: { checkedInAt: true },
    }),

  // Undo. A hard delete — a check-in is a fact record with no archived
  // state — of every check-in this guest has for the day, across all of
  // their invites, scoped to the event.
  deleteForGuestDay: (eventId: string, guestId: string, eventDayId: string) =>
    prisma.checkIn.deleteMany({
      where: { eventDayId, invite: { guestId, eventId } },
    }),
};
