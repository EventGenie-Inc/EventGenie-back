import { Prisma, type StoredFile, type StoredFileDeliveryType, type StoredFileKind, type StoredFileResourceType, type StoredFileStatus } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  STORED FILE REPOSITORY — Prisma only (storage module).
//
//  Status only moves forward (see the model in schema.prisma). Every write
//  that moves it is conditional on the status it moves from, so two
//  requests racing on one file can't both win.
// ─────────────────────────────────────────

const OPEN_FOR_DELETION: StoredFileStatus[] = ['SIGNED', 'UPLOADED', 'ATTACHED'];

export interface NewStoredFile {
  publicId: string;
  resourceType: StoredFileResourceType;
  deliveryType: StoredFileDeliveryType;
  kind: StoredFileKind;
  tenantId: string;
  eventId: string | null;
  uploadedByUserId?: string | null;
  uploadedByInviteId?: string | null;
}

export interface ClaimedFile {
  id: string;
  publicId: string;
  resourceType: StoredFileResourceType;
  deliveryType: StoredFileDeliveryType;
  deleteAttempts: number;
}

export const storedFileRepository = {
  create: (data: NewStoredFile, db: Db = prisma) =>
    db.storedFile.create({ data: { ...data, status: 'SIGNED' } }),

  findByPublicId: (publicId: string, db: Db = prisma) =>
    db.storedFile.findUnique({ where: { publicId } }),

  findById: (id: string, db: Db = prisma) =>
    db.storedFile.findUnique({ where: { id } }),

  // Its real size, known: from Cloudinary's notification or an explicit
  // call. A SIGNED file becomes UPLOADED; any other keeps its status.
  recordMeasured: async (id: string, bytes: number, format: string | null, now: Date, db: Db = prisma): Promise<void> => {
    await db.storedFile.updateMany({ where: { id, status: 'SIGNED' }, data: { status: 'UPLOADED', uploadedAt: now } });
    await db.storedFile.update({ where: { id }, data: { bytes, format } });
  },

  // ATTACHED to its owner: from SIGNED or UPLOADED, or from ATTACHED to
  // the draft named (a wizard draft's cover becoming its event's). Returns
  // whether this call attached it: false means it was used or released in
  // the meantime.
  attach: async (
    id: string,
    owner: { eventId: string | null; draftId: string | null; fromDraftId?: string | null },
    now: Date,
    db: Db = prisma
  ): Promise<boolean> => {
    const from: Prisma.StoredFileWhereInput[] = [{ status: { in: ['SIGNED', 'UPLOADED'] } }];
    if (owner.fromDraftId) from.push({ status: 'ATTACHED', draftId: owner.fromDraftId });
    const { count } = await db.storedFile.updateMany({
      where: { id, OR: from },
      data: { status: 'ATTACHED', attachedAt: now, eventId: owner.eventId, draftId: owner.draftId },
    });
    return count === 1;
  },

  // Marks every file matching `where` that is still kept for deletion.
  // The worker deletes it (storage-deletion.worker.ts). Returns the count.
  requestDeletion: async (where: Prisma.StoredFileWhereInput, now: Date, db: Db = prisma): Promise<number> =>
    (await db.storedFile.updateMany({
      where: { AND: [where, { status: { in: OPEN_FOR_DELETION } }] },
      data: { status: 'DELETE_REQUESTED', deleteRequestedAt: now, nextDeleteAttemptAt: null },
    })).count,

  // Closed by a pipeline that deleted the file itself (guest documents).
  markDeletedWhere: async (where: Prisma.StoredFileWhereInput, now: Date, db: Db = prisma): Promise<number> =>
    (await db.storedFile.updateMany({
      where: { AND: [where, { status: { not: 'DELETED' } }] },
      data: { status: 'DELETED', deletedAt: now, nextDeleteAttemptAt: null },
    })).count,

  // ── The worker ────────────────────────────

  // Claims up to `limit` files due for deletion, by taking a lease on them
  // (nextDeleteAttemptAt = leaseUntil) in one statement: SKIP LOCKED, so two
  // workers on two servers never take the same file. A guest document's
  // file is never claimed: the documents pipeline deletes those
  // (guest-document.service.ts). `ids`: only these (an immediate delete).
  claimDue: (now: Date, leaseUntil: Date, limit: number, ids?: string[]): Promise<ClaimedFile[]> =>
    prisma.$queryRaw<ClaimedFile[]>`
      UPDATE "StoredFile" SET "nextDeleteAttemptAt" = ${leaseUntil}
      WHERE "id" IN (
        SELECT s."id" FROM "StoredFile" s
        WHERE s."status" = 'DELETE_REQUESTED'
          AND (s."nextDeleteAttemptAt" IS NULL OR s."nextDeleteAttemptAt" <= ${now})
          AND NOT EXISTS (SELECT 1 FROM "GuestDocument" g WHERE g."storedFileId" = s."id")
          ${ids ? Prisma.sql`AND s."id" IN (${Prisma.join(ids.length ? ids : [''])})` : Prisma.empty}
        ORDER BY s."deleteRequestedAt" ASC NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "publicId", "resourceType", "deliveryType", "deleteAttempts"`,

  markDeleted: async (ids: string[], now: Date): Promise<number> =>
    ids.length === 0
      ? 0
      : (await prisma.storedFile.updateMany({
          where: { id: { in: ids }, status: 'DELETE_REQUESTED' },
          data: { status: 'DELETED', deletedAt: now, nextDeleteAttemptAt: null, lastDeleteError: null },
        })).count,

  recordFailure: (id: string, attempts: number, nextAttemptAt: Date, reason: string) =>
    prisma.storedFile.updateMany({
      where: { id, status: 'DELETE_REQUESTED' },
      data: { deleteAttempts: attempts, nextDeleteAttemptAt: nextAttemptAt, lastDeleteError: reason.slice(0, 500) },
    }),

  // ── Reconciliation ────────────────────────

  // Every row whose public id starts with `prefix`, in pages (a cursor on id).
  findByPrefixPage: (prefix: string, afterId: string | null, take: number): Promise<Pick<StoredFile, 'id' | 'publicId' | 'status' | 'bytes' | 'kind'>[]> =>
    prisma.storedFile.findMany({
      where: { publicId: { startsWith: prefix }, ...(afterId ? { id: { gt: afterId } } : {}) },
      select: { id: true, publicId: true, status: true, bytes: true, kind: true },
      orderBy: { id: 'asc' },
      take,
    }),
};
