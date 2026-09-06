import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';
import crypto from 'crypto';

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
          },
        },
      },
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
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
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
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
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