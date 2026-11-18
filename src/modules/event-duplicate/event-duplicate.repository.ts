import { Prisma, type EventStatus } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;

// ─────────────────────────────────────────
//  EVENT DUPLICATE REPOSITORY — Prisma only.
//
//  Reads take an event id the service has already scoped
//  (eventService.getById, or a caller trusted to pass its own); writes run
//  in the service's one transaction.
// ─────────────────────────────────────────

export const eventDuplicateRepository = {
  // Everything that is copied, live rows only. The source may be archived.
  findSource: (eventId: string) =>
    prisma.event.findUniqueOrThrow({
      where: { id: eventId },
      include: {
        eventDays: { where: { isArchived: false }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] },
        rsvpFields: { where: { isArchived: false }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
        program: { include: { programItems: { where: { isArchived: false }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] } } },
        memoryHub: true,
        invitationDesigns: { where: { isArchived: false }, take: 1, include: { storedFile: { select: { status: true } } } },
        coverFile: { select: { status: true } },
      },
    }),

  // The status of a file named by public id alone (a legacy cover with no
  // coverFileId): null when it has no row.
  findFileStatus: async (publicId: string) =>
    (await prisma.storedFile.findUnique({ where: { publicId }, select: { status: true } }))?.status ?? null,

  // The guests a copy takes: live, not plus-ones, not awaiting approval (a
  // declined registration is archived, so never here either), each with the
  // days of their live invites.
  findGuestsToCopy: (eventId: string) =>
    prisma.guest.findMany({
      where: { eventId, isArchived: false, hostGuestId: null, pendingApproval: false },
      select: {
        firstName: true,
        surname: true,
        email: true,
        phoneNumber: true,
        plusOnesAllowed: true,
        invites: { where: { isArchived: false }, select: { inviteEventDay: { select: { eventDayId: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    }),

  createEvent: (tx: Tx, data: Prisma.EventUncheckedCreateInput & { id: string; status: EventStatus }) =>
    tx.event.create({ data }),

  createDay: (tx: Tx, data: Prisma.EventDayUncheckedCreateInput) => tx.eventDay.create({ data, select: { id: true } }),

  createFields: (tx: Tx, data: Prisma.RsvpFieldCreateManyInput[]) =>
    data.length ? tx.rsvpField.createMany({ data }) : Promise.resolve({ count: 0 }),

  createProgram: (tx: Tx, data: Prisma.EventProgramUncheckedCreateInput) => tx.eventProgram.create({ data, select: { id: true } }),

  createProgramItems: (tx: Tx, data: Prisma.ProgramItemCreateManyInput[]) =>
    data.length ? tx.programItem.createMany({ data }) : Promise.resolve({ count: 0 }),

  createMemoryHub: (tx: Tx, data: Prisma.MemoryHubUncheckedCreateInput) => tx.memoryHub.create({ data }),

  createDesign: (tx: Tx, data: Prisma.InvitationDesignUncheckedCreateInput) => tx.invitationDesign.create({ data }),
};
