import { type GuestDocumentSource, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { INVITE_TOKEN_USABLE } from '../registration-approval/registration-approval-gate.util.js';

// Prisma queries only; the rules are guest-document.service.ts's.

type Db = Prisma.TransactionClient | typeof prisma;

// A document whose file is still there and nobody has asked to delete.
const LIVE = { deletedAt: null, deleteRequestedAt: null } as const;

export interface CreateGuestDocumentInput {
  id: string;
  eventId: string;
  rsvpFieldId: string;
  inviteId: string | null;
  source: GuestDocumentSource;
  cloudinaryPublicId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storedFileId: string;
}

export const guestDocumentRepository = {

  // ── Uploading ─────────────────────────────

  // What an upload through an invitation needs: the invite, its guest's
  // state, and its event's state and questions.
  // Removed, awaiting approval or declined: the same as an unknown token
  // (registration-approval-gate.util.ts).
  findInviteForUpload: (token: string) =>
    prisma.invite.findUnique({
      where: { token, ...INVITE_TOKEN_USABLE },
      select: {
        id: true,
        isArchived: true,
        used: true,
        expiresAt: true,
        guest: { select: { isArchived: true } },
        event: {
          select: {
            id: true,
            tenantId: true,
            // The event's own entitlement, for its document allowance.
            eventPass: { select: { passTier: true } },
            isArchived: true,
            status: true,
            rsvpDeadline: true,
            eventDays: { where: { isArchived: false }, select: { date: true, endTime: true } },
            rsvpFields: { where: { isArchived: false }, select: { id: true, fieldType: true } },
          },
        },
      },
    }),

  create: (data: CreateGuestDocumentInput, db: Db = prisma) => db.guestDocument.create({ data }),

  // ── Answers ───────────────────────────────

  findByIds: (ids: string[], db: Db = prisma) =>
    ids.length === 0 ? Promise.resolve([]) : db.guestDocument.findMany({ where: { id: { in: ids } } }),

  // Attaches documents not yet attached, still live, to an invite. A
  // conditional write: the orphan sweep requests deletion only of what is
  // still unattached, so of the two exactly one wins. Returns the count.
  // Their StoredFiles are marked ATTACHED with them.
  attach: async (ids: string[], inviteId: string, now: Date, db: Db): Promise<number> => {
    if (ids.length === 0) return 0;
    const { count } = await db.guestDocument.updateMany({
      where: { id: { in: ids }, attachedAt: null, ...LIVE },
      data: { attachedAt: now, inviteId },
    });
    await db.storedFile.updateMany({
      where: { guestDocument: { is: { id: { in: ids }, attachedAt: now } }, status: { in: ['SIGNED', 'UPLOADED'] } },
      data: { status: 'ATTACHED', attachedAt: now },
    });
    return count;
  },

  // ── Reading ───────────────────────────────

  // The invite's own live, attached documents (the guest page's prefill).
  findLiveAttachedForInvite: (inviteId: string) =>
    prisma.guestDocument.findMany({
      where: { inviteId, attachedAt: { not: null }, ...LIVE },
      orderBy: { uploadedAt: 'asc' },
    }),

  // Live, attached documents among `ids` (an organiser's guest details and
  // the export: which answers still have their file).
  findLiveAttachedByIds: (ids: string[]) =>
    ids.length === 0
      ? Promise.resolve([])
      : prisma.guestDocument.findMany({ where: { id: { in: ids }, attachedAt: { not: null }, ...LIVE } }),

  findLiveAttachedIdsForEvent: async (eventId: string): Promise<Set<string>> =>
    new Set(
      (await prisma.guestDocument.findMany({
        where: { eventId, attachedAt: { not: null }, ...LIVE },
        select: { id: true },
      })).map((d) => d.id)
    ),

  findById: (id: string) => prisma.guestDocument.findUnique({ where: { id } }),

  // The event's document storage (its own allowance, never the Memory
  // Hub's): every document whose file is still kept, attached or not.
  sumLiveBytesForEvent: async (eventId: string, db: Db = prisma): Promise<number> =>
    (await db.guestDocument.aggregate({ where: { eventId, ...LIVE }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0,

  // The event's row lock: every upload's allowance check and its row are
  // written under it, so two uploads can't both take the last of the space.
  lockEvent: async (tx: Prisma.TransactionClient, eventId: string): Promise<void> => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  },

  // A guest's kept documents, every invite of theirs: the guest details'
  // documentCount, for the warning before archiving them.
  countLiveForGuest: (guestId: string) =>
    prisma.guestDocument.count({ where: { invite: { guestId }, attachedAt: { not: null }, ...LIVE } }),

  // The event's kept, answered documents (attached: an unsubmitted upload
  // isn't the organiser's to see), archived guests' included, oldest first:
  // the organiser's document list, and its count on the event detail.
  findKeptAttachedForEvent: (eventId: string) =>
    prisma.guestDocument.findMany({
      where: { eventId, attachedAt: { not: null }, ...LIVE },
      select: {
        id: true,
        cloudinaryPublicId: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        uploadedAt: true,
        rsvpField: { select: { id: true, label: true } },
        invite: { select: { isArchived: true, guest: { select: { id: true, firstName: true, surname: true, isArchived: true } } } },
      },
      orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
    }),

  countKeptAttachedForEvent: (eventId: string) =>
    prisma.guestDocument.count({ where: { eventId, attachedAt: { not: null }, ...LIVE } }),

  // ── Deleting ──────────────────────────────

  // Live documents matching `where` that have no StoredFile (a row older
  // than the records): the service writes one before requesting deletion.
  findLiveWithoutFile: (where: Prisma.GuestDocumentWhereInput, db: Db = prisma) =>
    db.guestDocument.findMany({
      where: { ...where, ...LIVE, storedFileId: null },
      select: { id: true, eventId: true, cloudinaryPublicId: true, event: { select: { tenantId: true } } },
    }),

  setStoredFile: (id: string, storedFileId: string, db: Db = prisma) =>
    db.guestDocument.update({ where: { id }, data: { storedFileId } }),

  // Marks every live document matching `where` for deletion, and its
  // StoredFile with it: the storage worker deletes the file and marks the
  // document deleted (stored-file.repository.ts's markDeleted).
  requestDeletion: async (where: Prisma.GuestDocumentWhereInput, now: Date, db: Db = prisma): Promise<number> => {
    await db.storedFile.updateMany({
      where: { guestDocument: { is: { ...where, ...LIVE } }, status: { in: ['SIGNED', 'UPLOADED', 'ATTACHED'] } },
      data: { status: 'DELETE_REQUESTED', deleteRequestedAt: now, nextDeleteAttemptAt: null },
    });
    return (await db.guestDocument.updateMany({ where: { ...where, ...LIVE }, data: { deleteRequestedAt: now } })).count;
  },

  // The StoredFiles of documents requested and not yet deleted, matching
  // `where`: what an immediate delete (deleteNow) is asked to do.
  findRequestedFileIds: async (where: Prisma.GuestDocumentWhereInput, db: Db = prisma): Promise<string[]> =>
    (await db.guestDocument.findMany({
      where: { ...where, deleteRequestedAt: { not: null }, deletedAt: null, storedFileId: { not: null } },
      select: { storedFileId: true },
    })).map((d) => d.storedFileId!),
};
