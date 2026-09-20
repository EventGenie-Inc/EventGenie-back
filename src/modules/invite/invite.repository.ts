import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';
import crypto from 'crypto';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';

export const inviteRepository = {

  // Excludes plus-ones' invites — they never had one to send, so they don't
  // belong in the invite management / outstanding-invitations / resend
  // list. A plus-one is visible instead via the guest table, where their
  // hostGuestId names their host.
  findAll: (eventId: string) =>
    prisma.invite.findMany({
      where: { eventId, isArchived: false, guest: { hostGuestId: null } },
      include: { guest: true, inviteEventDay: { include: { eventDay: true } } },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string, includeArchived = false) =>
    prisma.invite.findFirst({
      where: { id, ...(includeArchived ? {} : { isArchived: false }) },
      include: {
        guest: true,
        inviteEventDay: { include: { eventDay: true } },
        attendances: { include: { eventDay: true } },
      },
    }),

  // Doubles as the guest-ownership/eligibility check for the bulk-send
  // flow — must filter BOTH isArchived flags explicitly (an invite can be
  // archived independently of its guest and vice versa), plus hostGuestId
  // (a plus-one has no invitation of their own to send). Any requested
  // guestId missing from the result is wrong-event, archived-guest,
  // archived-invite, or a plus-one, and the caller rejects the whole batch
  // on that basis.
  findByGuestIds: (eventId: string, guestIds: string[]) =>
    prisma.invite.findMany({
      where: {
        eventId,
        guestId: { in: guestIds },
        isArchived: false,
        guest: { isArchived: false, hostGuestId: null },
      },
      include: { guest: true },
    }),

  markDelivered: (id: string) =>
    prisma.invite.update({ where: { id }, data: { deliveredAt: new Date() } }),

  // Reminder candidates — STRUCTURAL filter only: this event, live invite,
  // live guest, and never a plus-one (hostGuestId: null — a plus-one has
  // no contact and cannot be reminded, so they are excluded here rather
  // than left to fail at send time). Every live invite of each matching
  // guest is returned, deliberately NOT narrowed to status PENDING /
  // delivered: whether a guest "has responded" must be judged across all
  // of their live invites (one ACCEPTED invite means answered, even if an
  // older duplicate is still PENDING), and that cannot be seen once the
  // answered one has been filtered out. invite-reminder.util.ts's
  // classifyGuestForReminder applies the state rules to the result.
  // guestIds omitted = every guest on the event.
  findReminderCandidates: (eventId: string, guestIds?: string[]) =>
    prisma.invite.findMany({
      where: {
        eventId,
        isArchived: false,
        guest: { isArchived: false, hostGuestId: null },
        ...(guestIds ? { guestId: { in: guestIds } } : {}),
      },
      include: { guest: true },
      orderBy: { createdAt: 'desc' },
    }),

  // Atomically claims the right to remind this invite's guest. The single
  // UPDATE re-checks, at the moment of the write, everything that must
  // still be true — still live, still un-responded, not reminded since
  // `cutoff` — so of two overlapping "remind" requests exactly one wins
  // and the guest is texted once. A read-then-send check could not give
  // that guarantee. Returns false when the claim is lost, whatever the
  // reason (already reminded, or the guest just answered).
  claimReminder: async (id: string, cutoff: Date, claimedAt: Date): Promise<boolean> => {
    const { count } = await prisma.invite.updateMany({
      where: {
        id,
        isArchived: false,
        status: 'PENDING',
        OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lte: cutoff } }],
      },
      data: { lastRemindedAt: claimedAt },
    });
    return count === 1;
  },

  // Undoes a claim after a failed send so a guest who never received the
  // reminder isn't locked out of the next attempt. Matches on claimedAt so
  // it can only ever undo THIS claim, never a later one.
  releaseReminderClaim: (id: string, claimedAt: Date, previous: Date | null) =>
    prisma.invite.updateMany({
      where: { id, lastRemindedAt: claimedAt },
      data: { lastRemindedAt: previous },
    }),

  // guest.plusOnes, attendances, rsvpResponses, and ticketPurchases are
  // included so rsvp.service.ts's validate() can hand an edit form
  // everything it needs to prefill a guest's previous answer — validate()
  // is the only caller, and this is its sole query.
  findByToken: (token: string) =>
    prisma.invite.findUnique({
      where: { token },
      include: {
        guest: { include: { plusOnes: { where: { isArchived: false } } } },
        inviteEventDay: { include: { eventDay: true } },
        attendances: true,
        rsvpResponses: true,
        ticketPurchases: true,
        event: {
          include: {
            eventDays: { where: { isArchived: false } },
            rsvpFields: { where: { isArchived: false }, orderBy: { order: 'asc' } },
            tickets: { where: { isArchived: false, isAvailable: true } },
            // Event Pass batch — alongside eventDays, needed by
            // memory-hub.service.ts's guest-facing paths (which resolve
            // this invite's `.event` into event-scoped tier checks) to
            // resolve entitlement with no extra query.
            eventPass: true,
          },
        },
      },
    }),

  // Feeds event-public.service.ts's duplicate-registration path: a
  // returning public registrant is matched back to their existing Guest
  // by contact, then handed the token of THIS invite so they land back
  // in their own RSVP rather than a stranded dead end. Most-recent
  // non-archived invite — a guest can in principle hold more than one
  // (an organiser can archive one invite without archiving its guest,
  // see invite.service.ts's archive), so this picks the one still live.
  findLatestActiveByGuestId: (guestId: string) =>
    prisma.invite.findFirst({
      where: { guestId, isArchived: false },
      orderBy: { createdAt: 'desc' },
    }),

  create: (eventId: string, userId: string, data: CreateInviteDto) =>
    prisma.$transaction(async (tx) => {
      const invite = await tx.invite.create({
        data: {
          eventId,
          guestId: data.guestId,
          token: crypto.randomBytes(32).toString('hex'),
          status: 'PENDING',
          used: false,
          deliveryMethod: data.deliveryMethod,
          // Optional fields must be null (not undefined) for exactOptionalPropertyTypes
          expiresAt: data.expiresAt ? parseClientDateTime(data.expiresAt) : null,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      await tx.inviteEventDay.createMany({
        data: data.invitedDayIds.map((eventDayId) => ({
          inviteId: invite.id,
          eventDayId,
        })),
      });

      return invite;
    }),

  update: (id: string, userId: string, data: UpdateInviteDto) =>
    prisma.invite.update({
      where: { id },
      data: {
        ...(data.status !== undefined && { status: data.status }),
        ...(data.deliveryMethod !== undefined && { deliveryMethod: data.deliveryMethod }),
        // For nullable DateTime: explicitly set null or the Date value
        ...(data.expiresAt !== undefined && {
          expiresAt: data.expiresAt ? parseClientDateTime(data.expiresAt) : null,
        }),
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.invite.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),

  reactivate: (id: string, userId: string) =>
    prisma.invite.update({
      where: { id },
      data: { isArchived: false, updatedBy: userId },
    }),
};