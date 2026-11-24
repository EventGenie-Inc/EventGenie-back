import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient | typeof prisma;
import prisma from '../../shared/prisma/prisma.client.js';
import { type StoredDesignColumns } from './invitation-design.types.js';

// The CANVAS columns, all empty: every TEMPLATE and UPLOAD write clears
// them, so a CANVAS design switched back to a template or an upload passes
// the migration's CHECK (20261126090000_canvas_designs).
const NO_CANVAS = {
  document: Prisma.DbNull,
  documentVersion: null,
  format: null,
  svgMarkup: null,
  pngStoredFileId: null,
  envelopeColor: null,
  sealColor: null,
  hasRsvpButton: null,
};

// Every column for EVERY kind, every time: switching kind rewrites the
// same row and must null the other kinds' columns (the migration's CHECK
// constraint refuses a row that keeps both). A nullable Json column is
// cleared with Prisma.DbNull, not null.
const columnsFor = (data: StoredDesignColumns) => {
  if (data.kind === 'TEMPLATE') {
    return {
      kind: 'TEMPLATE' as const,
      templateId: data.templateId,
      templateVersion: data.templateVersion,
      overrides: data.overrides as unknown as Prisma.InputJsonValue,
      imageUrl: null,
      cloudinaryPublicId: null,
      width: null,
      height: null,
      altText: null,
      ...NO_CANVAS,
    };
  }
  if (data.kind === 'UPLOAD') {
    return {
      kind: 'UPLOAD' as const,
      templateId: null,
      templateVersion: null,
      overrides: Prisma.DbNull,
      imageUrl: data.imageUrl,
      cloudinaryPublicId: data.cloudinaryPublicId,
      width: data.width,
      height: data.height,
      altText: data.altText ?? null,
      ...NO_CANVAS,
    };
  }
  return {
    kind: 'CANVAS' as const,
    templateId: null,
    templateVersion: null,
    overrides: Prisma.DbNull,
    imageUrl: null,
    cloudinaryPublicId: null,
    width: null,
    height: null,
    altText: data.altText,
    document: data.document as Prisma.InputJsonValue,
    documentVersion: data.documentVersion,
    format: data.format,
    svgMarkup: data.svgMarkup,
    pngStoredFileId: data.pngStoredFileId,
    envelopeColor: data.envelopeColor,
    sealColor: data.sealColor,
    hasRsvpButton: data.hasRsvpButton,
  };
};

// The rendered card's file, for its URL (publicId and Cloudinary's format).
const WITH_RENDER = { pngStoredFile: { select: { publicId: true, format: true } } } as const;

// Scoping: InvitationDesign has no tenantId of its own. Every caller has
// already passed the event through eventService's tenant-scoped gate
// (transitive scoping, see STEERING), so these take a trusted eventId.
export const invitationDesignRepository = {
  findActiveByEventId: (eventId: string, db: Db = prisma) =>
    db.invitationDesign.findFirst({ where: { eventId, isArchived: false } }),

  // The organiser's view: the row and its rendered card's file.
  findActiveWithRender: (eventId: string, db: Db = prisma) =>
    db.invitationDesign.findFirst({ where: { eventId, isArchived: false }, include: WITH_RENDER }),

  // storedFileId: the UPLOAD's StoredFile, null for a TEMPLATE or a CANVAS
  // (whose rendered card is pngStoredFileId, in its columns).
  update: (id: string, userId: string, data: StoredDesignColumns, storedFileId: string | null, db: Db = prisma) =>
    db.invitationDesign.update({
      where: { id },
      data: { ...columnsFor(data), storedFileId, updatedBy: userId },
      include: WITH_RENDER,
    }),

  create: (eventId: string, userId: string, data: StoredDesignColumns, storedFileId: string | null, db: Db = prisma) =>
    db.invitationDesign.create({
      data: { eventId, ...columnsFor(data), storedFileId, isArchived: false, createdBy: userId, updatedBy: userId },
      include: WITH_RENDER,
    }),

  // Reset to default: the design is archived (kept as history, never
  // served). The partial unique index lets the next save create a new row.
  archive: (id: string, userId: string, db: Db = prisma) =>
    db.invitationDesign.update({ where: { id }, data: { isArchived: true, updatedBy: userId } }),

  // ── A CANVAS design's images (StoredFile kind DESIGN_ASSET) ──
  // They belong to the event, like the design itself: the event's ATTACHED
  // DESIGN_ASSET files are the active design's images, so no join table.

  findFilesByPublicIds: (publicIds: string[], db: Db = prisma) =>
    publicIds.length === 0 ? Promise.resolve([]) : db.storedFile.findMany({ where: { publicId: { in: publicIds } } }),

  // (An archived event's design files are requested by its media purge, 30
  // days later: media-retention.repository.ts.)
};

// The partial unique index ("InvitationDesign_eventId_active_key") firing:
// two first-ever PUTs for the same event raced and the other one won.
export const isActiveDesignUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
