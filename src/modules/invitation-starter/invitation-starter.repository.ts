import { Prisma, type InvitationStarterCategory, type InvitationStarterStatus } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

// ─────────────────────────────────────────
//  STARTER DESIGNS — Prisma only. Starters are the platform's (no tenant),
//  so there is no tenant scoping: every route that reaches these is super
//  admin only, or reads published starters only.
// ─────────────────────────────────────────

const WITH_PREVIEW = { previewStoredFile: { select: { publicId: true, format: true } } } as const;

export type StarterRow = Prisma.InvitationStarterGetPayload<{ include: typeof WITH_PREVIEW }>;

const ORDER: Prisma.InvitationStarterOrderByWithRelationInput[] = [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

export const invitationStarterRepository = {
  // Every write to one starter holds its row lock, so two saves (or a save
  // and a publish) never interleave.
  withLock: <T>(id: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "InvitationStarter" WHERE "id" = ${id} FOR UPDATE`;
        return fn(tx);
      },
      { maxWait: 10_000, timeout: 30_000 }
    ),

  findById: (id: string, db: Db = prisma): Promise<StarterRow | null> =>
    db.invitationStarter.findUnique({ where: { id }, include: WITH_PREVIEW }),

  findPublished: (id: string): Promise<StarterRow | null> =>
    prisma.invitationStarter.findFirst({ where: { id, status: 'PUBLISHED' }, include: WITH_PREVIEW }),

  list: (where: { status?: InvitationStarterStatus; category?: InvitationStarterCategory; format?: string }): Promise<StarterRow[]> =>
    prisma.invitationStarter.findMany({ where, include: WITH_PREVIEW, orderBy: ORDER }),

  // Organisers' picker: published only, without the document or the SVG.
  listPublishedCards: (where: { category?: InvitationStarterCategory; format?: string }) =>
    prisma.invitationStarter.findMany({
      where: { ...where, status: 'PUBLISHED' },
      orderBy: ORDER,
      select: {
        id: true, name: true, category: true, format: true, envelopeColor: true, sealColor: true,
        previewStoredFile: { select: { publicId: true, format: true } },
      },
    }),

  allIds: (db: Db = prisma): Promise<string[]> =>
    db.invitationStarter.findMany({ select: { id: true } }).then((rows) => rows.map((r) => r.id)),

  nextSortOrder: async (db: Db = prisma): Promise<number> =>
    ((await db.invitationStarter.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1,

  create: (data: Prisma.InvitationStarterUncheckedCreateInput, db: Db = prisma): Promise<StarterRow> =>
    db.invitationStarter.create({ data, include: WITH_PREVIEW }),

  update: (id: string, data: Prisma.InvitationStarterUncheckedUpdateInput, db: Db = prisma): Promise<StarterRow> =>
    db.invitationStarter.update({ where: { id }, data, include: WITH_PREVIEW }),

  delete: (id: string, db: Db) => db.invitationStarter.delete({ where: { id } }),

  setSortOrder: (id: string, sortOrder: number, db: Db) =>
    db.invitationStarter.update({ where: { id }, data: { sortOrder }, select: { id: true } }),

  // A starter's files (STARTER_ASSET, STARTER_RENDER) by public id: to tell
  // which of a document's images are already the starter's.
  findFilesByPublicIds: (publicIds: string[], db: Db = prisma) =>
    publicIds.length === 0 ? Promise.resolve([]) : db.storedFile.findMany({ where: { publicId: { in: publicIds } } }),
};
