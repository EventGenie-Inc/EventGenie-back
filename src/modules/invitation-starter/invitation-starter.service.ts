import { type InvitationStarterCategory, type InvitationStarterStatus, type Prisma, type StoredFile } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { adminAuditService } from '../admin-audit/admin-audit.service.js';
import { ADMIN_AUDIT_ACTIONS, type AdminAuditAction } from '../admin-audit/admin-audit.types.js';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { storedFileService, uploadNotFound } from '../storage/stored-file.service.js';
import { storageDeletionWorker } from '../storage/storage-deletion.worker.js';
import { starterAssetFolder } from '../upload/upload-folders.js';
import { STARTER_ASSET_MAX_BYTES } from '../upload/upload-constants.js';
import { type UploadSignatureResponse } from '../upload/upload.types.js';
import {
  assertValidCanvasDocument,
  canvasImagePublicIdFromUrl,
  canvasImageSources,
  type CanvasImageContext,
} from '../invitation-design/canvas-document-validation.util.js';
import { cleanCanvasSvg } from '../invitation-design/canvas-svg-sanitiser.util.js';
import { assertRenderFits, renderTooLarge } from '../invitation-design/canvas-render.util.js';
import { designRenderUrl } from '../invitation-design/invitation-design-guest.util.js';
import { type CanvasFormat } from '../invitation-design/canvas-design.constants.js';
import { invitationStarterRepository, type StarterRow } from './invitation-starter.repository.js';
import { parseStarterFilters, parseStarterInput } from './invitation-starter-input.util.js';
import {
  STARTER_ERROR_CODES as CODES,
  type AdminStarterDetail,
  type AdminStarterSummary,
  type StarterCard,
  type StarterCopy,
} from './invitation-starter.types.js';

type Tx = Prisma.TransactionClient;

// ─────────────────────────────────────────
//  STARTER DESIGNS (STEERING "Invitation designs: starter designs")
//
//  CANVAS designs the super admin makes and publishes for organisers to
//  start from. Checked by Round 1's own validator, SVG cleaner and render
//  checks; the one difference is where its images may come from: the
//  starter's own asset folder (CanvasImageContext), never an event's.
//
//  Its files are the platform's: StoredFile rows held by the internal
//  e-velope organisation (Tenant.isInternal, the one that holds event
//  templates), with no event and the starter's id, in
//  <env>/platform/starters/<starterId>/{asset,preview}/<uuid>.
//
//  Picking one (copyToEvent) copies its images into new files of the
//  organiser's event and hands back the document pointing at those: a
//  design never references a starter's file, so editing, retiring or
//  deleting a starter never touches a design made from it.
//
//  Every super admin change is audit-logged, in its own transaction.
// ─────────────────────────────────────────

const ASSET_NOT_OURS_MESSAGE = "One of this starter's images wasn't uploaded for it. Upload it again from the starter's editor.";
const PREVIEW_NOT_OURS_MESSAGE = "This starter's preview wasn't uploaded for it. Save the starter again from the editor.";

const notFound = (): HttpError => new HttpError(404, 'Starter design not found', CODES.NOT_FOUND);

const internalTenantId = async (): Promise<string> => {
  const tenant = await tenantRepository.findInternal();
  // Made by the custom tiers migration; never deleted.
  if (!tenant) throw new Error('The internal e-velope organisation is missing');
  return tenant.id;
};

const imageContext = (starterId: string): CanvasImageContext =>
  ({ cloudName: requireCloudinaryConfig().cloudName, assetFolder: starterAssetFolder(starterId) });

const toSummary = (row: StarterRow): AdminStarterSummary => ({
  id: row.id,
  name: row.name,
  category: row.category,
  format: row.format as CanvasFormat,
  status: row.status,
  sortOrder: row.sortOrder,
  publishedAt: row.publishedAt,
  previewUrl: designRenderUrl(row.previewStoredFile),
  envelopeColor: row.envelopeColor,
  sealColor: row.sealColor,
  altText: row.altText,
  hasDesign: row.document !== null,
  hasRsvpButton: row.hasRsvpButton,
  createdById: row.createdById,
  updatedById: row.updatedById,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toDetail = (row: StarterRow): AdminStarterDetail => ({
  ...toSummary(row),
  document: row.document,
  documentVersion: row.documentVersion,
  svgMarkup: row.svgMarkup,
  previewPublicId: row.previewStoredFile?.publicId ?? null,
});

const audit = (tx: Tx, actorUserId: string, action: AdminAuditAction, details: Record<string, unknown>) =>
  adminAuditService.record({ actorUserId, tenantId: null, action, details }, tx);

const isStartersAsset = (file: StoredFile | undefined, starterId: string): boolean =>
  !!file && file.kind === 'STARTER_ASSET' && file.status === 'ATTACHED' && file.starterId === starterId;

// What the starter's design no longer uses, requested in the save that
// stops using it: a replaced preview, and every image not kept.
const releaseStarterFiles = async (tx: Tx, starterId: string, oldPreviewId: string | null, keep: { previewId: string | null; assetIds: string[] }) => {
  await storedFileService.requestReplacedDeletion(tx, oldPreviewId, keep.previewId);
  await storedFileService.requestDeletion(tx, { starterId, kind: 'STARTER_ASSET', status: 'ATTACHED', id: { notIn: keep.assetIds } });
};

export const invitationStarterService = {
  // ── Super admin ─────────────────────────

  list: async (query: Record<string, unknown>): Promise<AdminStarterSummary[]> => {
    const filters = parseStarterFilters(query, { status: true });
    const rows = await invitationStarterRepository.list({
      ...(filters.status && { status: filters.status as InvitationStarterStatus }),
      ...(filters.category && { category: filters.category as InvitationStarterCategory }),
      ...(filters.format && { format: filters.format }),
    });
    return rows.map(toSummary);
  },

  get: async (id: string): Promise<AdminStarterDetail> => {
    const row = await invitationStarterRepository.findById(id);
    if (!row) throw notFound();
    return toDetail(row);
  },

  // A new DRAFT: name, category and format (its design, colours and alt text
  // may come later). Last in the order.
  create: async (body: unknown, actorUserId: string): Promise<AdminStarterDetail> => {
    const input = parseStarterInput(body, { creating: true });
    if (input.design) {
      // Its images and preview are signed for the starter's id, so a design
      // can only be saved once the starter exists.
      throw new HttpError(422, 'Create the starter first, then upload its images and save its design.', CODES.FIELD_INVALID);
    }
    return prisma.$transaction(async (tx) => {
      const row = await invitationStarterRepository.create({
        name: input.name!,
        category: input.category!,
        format: input.format!,
        envelopeColor: input.envelopeColor ?? null,
        sealColor: input.sealColor ?? null,
        altText: input.altText ?? null,
        status: 'DRAFT',
        sortOrder: await invitationStarterRepository.nextSortOrder(tx),
        createdById: actorUserId,
        updatedById: actorUserId,
      }, tx);
      await audit(tx, actorUserId, ADMIN_AUDIT_ACTIONS.INVITATION_STARTER_CREATED, { starterId: row.id, name: row.name });
      return toDetail(row);
    });
  },

  // Any of name, category, colours and alt text; and the design, whole
  // (document, documentVersion, svg, previewPublicId, with the format if it
  // changes), checked exactly as an organiser's CANVAS save is. A published
  // starter stays published and valid; designs already made from it are
  // untouched (they hold their own copies).
  update: async (id: string, body: unknown, actorUserId: string): Promise<AdminStarterDetail> => {
    const input = parseStarterInput(body, { creating: false });
    const before = await invitationStarterRepository.findById(id);
    if (!before) throw notFound();

    let checked: {
      document: Record<string, unknown>; svgMarkup: string; hasRsvpButton: boolean; imagePublicIds: string[];
      format: CanvasFormat; documentVersion: number; previewPublicId: string;
    } | null = null;
    const accepted = new Set<string>();
    if (input.design) {
      const format = input.format ?? (before.format as CanvasFormat);
      const doc = assertValidCanvasDocument(input.design.document, imageContext(id));
      const cleaned = cleanCanvasSvg(input.design.svg, { format, allowedImageUrls: new Set(doc.imageUrls), hasRsvpButton: doc.hasRsvpButton });
      if (cleaned.stripped.length > 0) {
        console.warn(`[invitation-starter] cleaned the SVG of starter ${id}; stripped: ${cleaned.stripped.join(', ')}`);
      }

      // New files, measured before the lock (Cloudinary calls).
      const tenantId = await internalTenantId();
      const known = new Map((await invitationStarterRepository.findFilesByPublicIds([...doc.imagePublicIds, input.design.previewPublicId])).map((f) => [f.publicId, f]));
      for (const publicId of doc.imagePublicIds) {
        if (isStartersAsset(known.get(publicId), id)) continue;
        const { file } = await storedFileService.acceptUpload({
          publicId, kind: 'STARTER_ASSET', resourceType: 'IMAGE', tenantId, eventId: null, starterId: id,
          notFoundMessage: ASSET_NOT_OURS_MESSAGE,
          tooLarge: (bytes) => new HttpError(422, `One of this starter's images is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). Images must be ${STARTER_ASSET_MAX_BYTES / (1024 * 1024)}MB or smaller.`),
        });
        accepted.add(file.id);
      }
      const sentPreview = known.get(input.design.previewPublicId);
      const previewUnchanged = !!sentPreview && before.previewStoredFileId === sentPreview.id && sentPreview.status === 'ATTACHED' && format === before.format;
      if (!previewUnchanged) {
        const { file, image } = await storedFileService.acceptUpload({
          publicId: input.design.previewPublicId, kind: 'STARTER_RENDER', resourceType: 'IMAGE', tenantId, eventId: null, starterId: id,
          notFoundMessage: PREVIEW_NOT_OURS_MESSAGE, measureImage: true, tooLarge: renderTooLarge,
        });
        assertRenderFits(image, format);
        accepted.add(file.id);
      }
      checked = {
        document: doc.document, svgMarkup: cleaned.svg, hasRsvpButton: doc.hasRsvpButton, imagePublicIds: doc.imagePublicIds,
        format, documentVersion: input.design.documentVersion, previewPublicId: input.design.previewPublicId,
      };
    }

    const row = await invitationStarterRepository.withLock(id, async (tx) => {
      const current = await invitationStarterRepository.findById(id, tx);
      if (!current) throw notFound();
      const data: Prisma.InvitationStarterUncheckedUpdateInput = { updatedById: actorUserId };
      if (input.name !== undefined) data.name = input.name;
      if (input.category !== undefined) data.category = input.category;
      if (input.envelopeColor !== undefined) data.envelopeColor = input.envelopeColor;
      if (input.sealColor !== undefined) data.sealColor = input.sealColor;
      if (input.altText !== undefined) data.altText = input.altText;

      if (checked) {
        // Read again under the lock: a save in between may have released a file.
        const files = new Map((await invitationStarterRepository.findFilesByPublicIds([...checked.imagePublicIds, checked.previewPublicId], tx)).map((f) => [f.publicId, f]));
        const assetIds: string[] = [];
        for (const publicId of checked.imagePublicIds) {
          const file = files.get(publicId);
          if (file && isStartersAsset(file, id)) {
            assetIds.push(file.id);
          } else if (file && accepted.has(file.id)) {
            await storedFileService.attach(tx, file.id, { eventId: null });
            assetIds.push(file.id);
          } else {
            throw uploadNotFound(ASSET_NOT_OURS_MESSAGE);
          }
        }
        const preview = files.get(checked.previewPublicId);
        if (!preview) throw uploadNotFound(PREVIEW_NOT_OURS_MESSAGE);
        if (!(current.previewStoredFileId === preview.id && preview.status === 'ATTACHED' && !accepted.has(preview.id))) {
          if (!accepted.has(preview.id)) throw uploadNotFound(PREVIEW_NOT_OURS_MESSAGE);
          await storedFileService.attach(tx, preview.id, { eventId: null });
        }
        Object.assign(data, {
          format: checked.format,
          document: checked.document as Prisma.InputJsonValue,
          documentVersion: checked.documentVersion,
          svgMarkup: checked.svgMarkup,
          hasRsvpButton: checked.hasRsvpButton,
          previewStoredFileId: preview.id,
        });
        await releaseStarterFiles(tx, id, current.previewStoredFileId, { previewId: preview.id, assetIds });
      }

      const saved = await invitationStarterRepository.update(id, data, tx);
      await audit(tx, actorUserId, ADMIN_AUDIT_ACTIONS.INVITATION_STARTER_UPDATED, {
        starterId: id, name: saved.name, status: saved.status,
        fields: Object.keys(body as object).filter((k) => !['document', 'svg'].includes(k)).concat(checked ? ['design'] : []),
      });
      return saved;
    });
    return toDetail(row);
  },

  // DRAFT → PUBLISHED, only when it is complete and its design still passes
  // every check (the document, the SVG cleaning with nothing to strip, every
  // image the starter's own saved file, the preview saved). Sets publishedAt.
  publish: async (id: string, actorUserId: string): Promise<AdminStarterDetail> => {
    const row = await invitationStarterRepository.withLock(id, async (tx) => {
      const current = await invitationStarterRepository.findById(id, tx);
      if (!current) throw notFound();
      if (current.status !== 'DRAFT') {
        throw new HttpError(409, `This starter is ${current.status.toLowerCase()}: only a draft can be published.`, CODES.STATUS_CONFLICT);
      }
      const missing = [
        ...(current.document === null ? ['design'] : []),
        ...(current.previewStoredFileId === null ? ['preview'] : []),
        ...(current.envelopeColor === null ? ['envelopeColor'] : []),
        ...(current.sealColor === null ? ['sealColor'] : []),
        ...(current.altText === null ? ['altText'] : []),
      ];
      if (missing.length > 0) {
        throw new HttpError(422, `This starter isn't finished, so it can't be published: it needs ${missing.join(', ')}.`, CODES.INCOMPLETE);
      }

      const incomplete = (why: string): HttpError => new HttpError(422, `This starter can't be published: ${why}. Save its design again.`, CODES.INCOMPLETE);
      let doc;
      try {
        doc = assertValidCanvasDocument(current.document, imageContext(id));
      } catch (err) {
        if (err instanceof HttpError) throw incomplete(`its design no longer passes the checks (${err.message})`);
        throw err;
      }
      const recleaned = cleanCanvasSvg(current.svgMarkup, { format: current.format as CanvasFormat, allowedImageUrls: new Set(doc.imageUrls), hasRsvpButton: doc.hasRsvpButton });
      if (recleaned.stripped.length > 0) throw incomplete('its picture has something the cleaner removes');
      const files = new Map((await invitationStarterRepository.findFilesByPublicIds(doc.imagePublicIds, tx)).map((f) => [f.publicId, f]));
      if (!doc.imagePublicIds.every((p) => isStartersAsset(files.get(p), id))) throw incomplete('one of its images is no longer saved');
      const preview = await tx.storedFile.findUnique({ where: { id: current.previewStoredFileId! } });
      if (!preview || preview.status !== 'ATTACHED' || preview.starterId !== id) throw incomplete('its preview is no longer saved');

      const saved = await invitationStarterRepository.update(id, { status: 'PUBLISHED', publishedAt: new Date(), updatedById: actorUserId }, tx);
      await audit(tx, actorUserId, ADMIN_AUDIT_ACTIONS.INVITATION_STARTER_PUBLISHED, { starterId: id, name: saved.name });
      return saved;
    });
    return toDetail(row);
  },

  // PUBLISHED or RETIRED → DRAFT (organisers stop seeing it; publishedAt is
  // kept, so it still can't be deleted).
  unpublish: (id: string, actorUserId: string) =>
    invitationStarterService.moveStatus(id, actorUserId, ['PUBLISHED', 'RETIRED'], 'DRAFT', ADMIN_AUDIT_ACTIONS.INVITATION_STARTER_UNPUBLISHED),

  // DRAFT or PUBLISHED → RETIRED. Its files are kept (its preview still shows
  // in the super admin's list); designs made from it are never touched.
  retire: (id: string, actorUserId: string) =>
    invitationStarterService.moveStatus(id, actorUserId, ['DRAFT', 'PUBLISHED'], 'RETIRED', ADMIN_AUDIT_ACTIONS.INVITATION_STARTER_RETIRED),

  moveStatus: async (
    id: string,
    actorUserId: string,
    from: InvitationStarterStatus[],
    to: InvitationStarterStatus,
    action: AdminAuditAction
  ): Promise<AdminStarterDetail> => {
    const row = await invitationStarterRepository.withLock(id, async (tx) => {
      const current = await invitationStarterRepository.findById(id, tx);
      if (!current) throw notFound();
      if (!from.includes(current.status)) {
        throw new HttpError(409, `This starter is ${current.status.toLowerCase()}, so it can't be made ${to.toLowerCase()}.`, CODES.STATUS_CONFLICT);
      }
      const saved = await invitationStarterRepository.update(id, { status: to, updatedById: actorUserId }, tx);
      await audit(tx, actorUserId, action, { starterId: id, name: saved.name, from: current.status, to });
      return saved;
    });
    return toDetail(row);
  },

  // Only one never published (publishedAt null): it goes, with every file
  // it holds (requested in the same transaction, deleted at once where
  // possible). One ever published can only be retired.
  remove: async (id: string, actorUserId: string): Promise<null> => {
    const fileIds = await invitationStarterRepository.withLock(id, async (tx) => {
      const current = await invitationStarterRepository.findById(id, tx);
      if (!current) throw notFound();
      if (current.publishedAt !== null) {
        throw new HttpError(409, 'This starter has been published, so it can only be retired, not deleted.', CODES.WAS_PUBLISHED);
      }
      const files = await tx.storedFile.findMany({ where: { starterId: id, status: { in: ['SIGNED', 'UPLOADED', 'ATTACHED'] } }, select: { id: true } });
      const ids = files.map((f) => f.id);
      if (ids.length > 0) await storedFileService.requestDeletion(tx, { id: { in: ids } });
      await invitationStarterRepository.delete(id, tx);
      await audit(tx, actorUserId, ADMIN_AUDIT_ACTIONS.INVITATION_STARTER_DELETED, { starterId: id, name: current.name, filesReleased: ids.length });
      return ids;
    });
    if (fileIds.length > 0) await storageDeletionWorker.deleteNow(fileIds);
    return null;
  },

  // The order organisers see: every starter's id, exactly once, first to last.
  reorder: async (body: unknown, actorUserId: string): Promise<AdminStarterSummary[]> => {
    const starterIds = body && typeof body === 'object' ? (body as { starterIds?: unknown }).starterIds : undefined;
    const invalidOrder = (): HttpError =>
      new HttpError(422, 'Send starterIds: every starter, each once, in the order to show them.', CODES.ORDER_INVALID);
    if (!Array.isArray(starterIds) || !starterIds.every((s) => typeof s === 'string') || new Set(starterIds).size !== starterIds.length) throw invalidOrder();
    await prisma.$transaction(async (tx) => {
      const all = await invitationStarterRepository.allIds(tx);
      if (all.length !== starterIds.length || !all.every((s) => starterIds.includes(s))) throw invalidOrder();
      for (const [i, id] of (starterIds as string[]).entries()) await invitationStarterRepository.setSortOrder(id, i, tx);
      await audit(tx, actorUserId, ADMIN_AUDIT_ACTIONS.INVITATION_STARTER_REORDERED, { starterIds });
    });
    return invitationStarterService.list({});
  },

  // A signed upload for the starter: an image to place (ASSET: STARTER_ASSET,
  // at most 10MB) or its preview (PREVIEW: STARTER_RENDER, at most 5MB, PNG
  // or WebP), held by the internal organisation, in the starter's folder.
  requestUploadSignature: async (id: string, actorUserId: string, body: unknown): Promise<UploadSignatureResponse> => {
    const row = await invitationStarterRepository.findById(id);
    if (!row) throw notFound();
    const purpose = body && typeof body === 'object' ? (body as { purpose?: unknown }).purpose : undefined;
    if (purpose !== 'ASSET' && purpose !== 'PREVIEW') {
      throw new HttpError(422, "Say what the upload is for: purpose 'ASSET' (an image for the starter) or 'PREVIEW' (its preview).", CODES.UPLOAD_PURPOSE_INVALID);
    }
    return storedFileService.signUpload({
      kind: purpose === 'ASSET' ? 'STARTER_ASSET' : 'STARTER_RENDER',
      tenantId: await internalTenantId(),
      eventId: null,
      starterId: id,
      uploadedBy: { userId: actorUserId },
    });
  },

  // ── Organisers ──────────────────────────

  // Published starters, for the picker: never the document. Every plan sees
  // them (the frontend shows them locked without invitationDesignsEnabled).
  listPublished: async (query: Record<string, unknown>): Promise<StarterCard[]> => {
    const filters = parseStarterFilters(query, { status: false });
    const rows = await invitationStarterRepository.listPublishedCards({
      ...(filters.category && { category: filters.category as InvitationStarterCategory }),
      ...(filters.format && { format: filters.format }),
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      format: row.format as CanvasFormat,
      previewUrl: designRenderUrl(row.previewStoredFile),
      envelopeColor: row.envelopeColor as string,
      sealColor: row.sealColor as string,
    }));
  },

  // The organiser's own copy of a published starter, for an event whose
  // access the caller (invitation-design.service.ts) has already checked:
  // each of its images copied into a new DESIGN_ASSET file of the event (an
  // unsaved upload: the 7-day window, then the event's own rules once
  // saved), and its document with every image URL now the copy's. Nothing
  // is saved. A draft, retired or unknown starter is 404; one whose image is
  // gone, 409 (its copies made so far released).
  copyToEvent: async (starterId: unknown, event: { id: string; tenantId: string }, userId: string): Promise<StarterCopy> => {
    if (typeof starterId !== 'string' || starterId.length === 0) {
      throw new HttpError(422, 'Choose a starter design (starterId).', CODES.FIELD_INVALID);
    }
    const starter = await invitationStarterRepository.findPublished(starterId);
    if (!starter) throw notFound();

    const ctx = imageContext(starter.id);
    const sources = canvasImageSources(starter.document);
    const rows = new Map(
      (await invitationStarterRepository.findFilesByPublicIds(sources.map((u) => canvasImagePublicIdFromUrl(u, ctx)).filter((p): p is string => !!p)))
        .map((f) => [f.publicId, f])
    );

    const copies: string[] = [];
    const urls = new Map<string, string>();
    const release = async (): Promise<void> => {
      if (copies.length === 0) return;
      try {
        await storedFileService.requestDeletion(prisma, { id: { in: copies } });
        await storageDeletionWorker.deleteNow(copies);
      } catch (err) {
        console.error("[invitation-starter] couldn't release a starter's copies; the unsaved sweep will", err);
      }
    };
    try {
      for (const url of sources) {
        const publicId = canvasImagePublicIdFromUrl(url, ctx);
        const row = publicId ? rows.get(publicId) : undefined;
        const copied = publicId && row && isStartersAsset(row, starter.id)
          ? await storedFileService.copyFile({
              source: { publicId, resourceType: 'IMAGE', status: row.status },
              kind: 'DESIGN_ASSET',
              tenantId: event.tenantId,
              eventId: event.id,
              uploadedByUserId: userId,
              forExistingEvent: true,
            })
          : null;
        if (!copied) {
          throw new HttpError(409, "This starter design can't be used just now. Choose another, or start from a blank card.", CODES.UNAVAILABLE);
        }
        copies.push(copied.fileId);
        urls.set(url, copied.secureUrl);
      }
    } catch (err) {
      await release();
      throw err;
    }

    // URLs are whole Cloudinary delivery URLs with a UUID public id: one
    // never contains another.
    let json = JSON.stringify(starter.document);
    for (const [from, to] of urls) json = json.split(from).join(to);
    return {
      starterId: starter.id,
      name: starter.name,
      format: starter.format as CanvasFormat,
      document: JSON.parse(json) as unknown,
      documentVersion: starter.documentVersion as number,
      envelopeColor: starter.envelopeColor as string,
      sealColor: starter.sealColor as string,
      altText: starter.altText as string,
    };
  },
};
