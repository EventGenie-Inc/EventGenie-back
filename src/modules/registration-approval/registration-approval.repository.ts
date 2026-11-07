import prisma from '../../shared/prisma/prisma.client.js';

// Prisma queries only; the rules are registration-approval.service.ts's.
// Guest has no tenantId of its own: the service gates on
// eventService.getScoped (tenant scope and the assignment lock) and passes
// that event's id into every query here.

// A registrant (never a plus-one) still on the guest list and awaiting approval.
const pendingRegistrant = (eventId: string) => ({
  eventId,
  isArchived: false,
  hostGuestId: null,
  pendingApproval: true,
});

export const registrationApprovalRepository = {
  countPending: (eventId: string) => prisma.guest.count({ where: pendingRegistrant(eventId) }),

  // Every pending registrant with their live plus-ones, their newest live
  // invite and the live days it attends. One query.
  findPending: (eventId: string) =>
    prisma.guest.findMany({
      where: pendingRegistrant(eventId),
      orderBy: [{ selfRegisteredAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        firstName: true,
        surname: true,
        email: true,
        phoneNumber: true,
        selfRegisteredAt: true,
        plusOnes: {
          where: { isArchived: false },
          orderBy: { createdAt: 'asc' },
          select: { id: true, firstName: true, surname: true },
        },
        invites: {
          where: { isArchived: false },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            attendances: {
              where: { eventDay: { isArchived: false } },
              select: { eventDay: { select: { id: true, label: true, date: true } } },
            },
          },
        },
      },
    }),

  // Every answer of these invites, newest first (rsvp-response.repository.ts's order).
  findAnswers: (inviteIds: string[]) =>
    inviteIds.length === 0
      ? Promise.resolve([])
      : prisma.rsvpResponse.findMany({
          where: { inviteId: { in: inviteIds } },
          include: { rsvpField: true },
          orderBy: { createdAt: 'desc' },
        }),

  // The guest on this event, archived or not, with what deciding needs.
  findGuest: (eventId: string, guestId: string) =>
    prisma.guest.findFirst({
      where: { id: guestId, eventId },
      select: {
        id: true,
        email: true,
        isArchived: true,
        hostGuestId: true,
        selfRegisteredAt: true,
        pendingApproval: true,
        registrationApprovedAt: true,
        registrationDeclinedAt: true,
      },
    }),

  // Approves the registrant and their plus-ones, only if the registrant is
  // still live and pending at the moment of the write: of two racing
  // decisions exactly one wins, so the invitation is emailed once.
  // Returns whether this call made the decision.
  approve: (eventId: string, guestId: string, userId: string, now: Date): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
      const decided = { pendingApproval: false, registrationApprovedAt: now, registrationDecidedBy: userId };
      const { count } = await tx.guest.updateMany({ where: { id: guestId, ...pendingRegistrant(eventId) }, data: decided });
      if (count === 0) return false;
      await tx.guest.updateMany({ where: { eventId, hostGuestId: guestId, pendingApproval: true }, data: decided });
      return true;
    }),

  // Declines the registrant: they, their plus-ones and all their invites
  // are archived (which frees their seats, and leaves their documents to
  // the archived-guest rule), under the same won-once condition as approve.
  decline: (eventId: string, guestId: string, userId: string, now: Date): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
      const decided = {
        pendingApproval: false,
        registrationDeclinedAt: now,
        registrationDecidedBy: userId,
        isArchived: true,
      };
      const { count } = await tx.guest.updateMany({ where: { id: guestId, ...pendingRegistrant(eventId) }, data: decided });
      if (count === 0) return false;
      await tx.guest.updateMany({ where: { eventId, hostGuestId: guestId, isArchived: false }, data: decided });
      await tx.invite.updateMany({
        where: { eventId, isArchived: false, OR: [{ guestId }, { guest: { hostGuestId: guestId } }] },
        data: { isArchived: true, updatedBy: userId },
      });
      return true;
    }),
};
