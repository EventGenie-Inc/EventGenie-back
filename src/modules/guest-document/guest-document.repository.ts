import { type GuestDocumentSource, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

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
  findInviteForUpload: (token: string) =>
    prisma.invite.findUnique({
      where: { token },
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

  // Counted in the event's storage (memory-hub.repository.ts's
  // sumBytesForEvent): every document whose file is still kept.
  sumLiveBytesForEvent: async (eventId: string): Promise<number> =>
    (await prisma.guestDocument.aggregate({ where: { eventId, ...LIVE }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0,

  // ── Deleting ──────────────────────────────

  // Marks every live document matching `where` for deletion. The file is
  // deleted afterwards (the service), and the sweep retries any not done.
  // Their StoredFiles show the request too (the storage worker leaves a
  // document's file alone: this pipeline deletes it).
  requestDeletion: async (where: Prisma.GuestDocumentWhereInput, now: Date, db: Db = prisma): Promise<number> => {
    await db.storedFile.updateMany({
      where: { guestDocument: { is: { ...where, ...LIVE } }, status: { in: ['SIGNED', 'UPLOADED', 'ATTACHED'] } },
      data: { status: 'DELETE_REQUESTED', deleteRequestedAt: now, nextDeleteAttemptAt: null },
    });
    return (await db.guestDocument.updateMany({ where: { ...where, ...LIVE }, data: { deleteRequestedAt: now } })).count;
  },

  // Requested and not yet deleted, with the tenant for the folder check.
  findPendingDeletion: (where: Prisma.GuestDocumentWhereInput = {}) =>
    prisma.guestDocument.findMany({
      where: { ...where, deleteRequestedAt: { not: null }, deletedAt: null },
      select: { id: true, eventId: true, cloudinaryPublicId: true, event: { select: { tenantId: true } } },
      orderBy: { deleteRequestedAt: 'asc' },
    }),

  // Their StoredFiles are closed with them.
  markDeleted: (ids: string[], now: Date) =>
    ids.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.$transaction(async (tx) => {
          await tx.storedFile.updateMany({
            where: { guestDocument: { is: { id: { in: ids } } }, status: { not: 'DELETED' } },
            data: { status: 'DELETED', deletedAt: now, nextDeleteAttemptAt: null },
          });
          return tx.guestDocument.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: now, lastDeleteError: null } });
        }),

  recordDeleteFailure: (ids: string[], reason: string) =>
    ids.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.guestDocument.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { lastDeleteError: reason.slice(0, 500) } }),
};
