import { type PlatformRole, type Prisma, type StoredFile } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { eventRepository } from '../event/event.repository.js';
import { requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { DESIGN_ASSET_MAX_BYTES, INVITATION_DESIGN_MAX_BYTES } from '../upload/upload-constants.js';
import { type UploadSignatureResponse } from '../upload/upload.types.js';
import { storedFileService, uploadNotFound } from '../storage/stored-file.service.js';
import { invitationDesignRepository, isActiveDesignUniqueViolation } from './invitation-design.repository.js';
import { assertValidDesignInput } from './invitation-design-validation.util.js';
import { assertCanvasBody } from './canvas-design-input.util.js';
import { assertValidCanvasDocument, designImageContext } from './canvas-document-validation.util.js';
import { cleanCanvasSvg } from './canvas-svg-sanitiser.util.js';
import { assertRenderFits, renderTooLarge } from './canvas-render.util.js';
import { invitationStarterService } from '../invitation-starter/invitation-starter.service.js';
import { CANVAS_ERROR_CODES } from './canvas-design.constants.js';
import { assertCanvasDesignsOnPlan, canDesignOn, canvasNotOnPlanMessage, designPlanFor } from './invitation-design-plan.util.js';
import { designRenderUrl } from './invitation-design-guest.util.js';
import { type CanvasDesignColumns, type PutInvitationDesignDto } from './invitation-design.types.js';
import { type ResolvedPlan } from '../subscription-tier-config/effective-plan.util.js';

type Tx = Prisma.TransactionClient;

// ─────────────────────────────────────────
//  INVITATION DESIGN SERVICE
//
//  Transitive tenant scoping, as for every event sub-resource: each method
//  gates on eventService.getScoped / getScopedWithPass (the lean ownership
//  lookups), which 404 another tenant's event exactly like a missing one.
//  SUPER_ADMIN passes through unscoped, as everywhere.
//
//  Three kinds share one active row per event:
//    TEMPLATE, UPLOAD  the template engine: every plan, no tier gating.
//                      Removed in a later round of EG-64; unchanged here.
//    CANVAS            the editor's design: saving it, and signing its
//                      uploads, need the plan setting invitationDesignsEnabled
//                      (invitation-design-plan.util.ts). Reading it and
//                      resetting to default never do.
// ─────────────────────────────────────────

// The same words the validator uses for an image signed for another event.
const DESIGN_NOT_OURS_MESSAGE = "This image wasn't uploaded for this event. Upload it again from this event's design page.";
const ASSET_NOT_OURS_MESSAGE = "One of this design's images wasn't uploaded for this event. Upload it again from the design editor.";
const RENDER_NOT_OURS_MESSAGE = "This design's picture wasn't uploaded for this event. Save the design again from the editor.";

const assertEventEditable = (status: string): void => {
  if (status === 'CANCELLED') {
    throw new HttpError(409, "This event has been cancelled, so its invitation design can't be changed.");
  }
};

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

// ── The organiser's view ──────────────────

type DesignWithRender = NonNullable<Awaited<ReturnType<typeof invitationDesignRepository.findActiveWithRender>>>;

// The full design (the document included: this is the organiser's own),
// the rendered card's URL, and whether it may be edited on the event's
// plan now. A CANVAS design saved before a downgrade stays (guests still see
// it) but isn't editable: `notEditableReason` says why, in the plan's words.
// TEMPLATE and UPLOAD designs are always editable (not gated).
export const toOrganiserDesign = (row: DesignWithRender, plan: ResolvedPlan | null) => {
  const { pngStoredFile, ...design } = row;
  const editable = row.kind !== 'CANVAS' || canDesignOn(plan);
  return {
    ...design,
    pngUrl: row.kind === 'CANVAS' ? designRenderUrl(pngStoredFile) : null,
    editable,
    notEditableReason: editable ? null : plan ? canvasNotOnPlanMessage(plan) : 'Invitation designs aren\'t available for this event.',
  };
};

// ── A CANVAS design's files ───────────────

// What a CANVAS design no longer uses, requested for deletion in the
// transaction that stops using it: its rendered card (unless it is the one
// now kept) and every image of the event's design that isn't kept.
const releaseCanvasFiles = async (tx: Tx, eventId: string, oldPngId: string | null, keep: { pngId: string | null; assetIds: string[] }): Promise<void> => {
  await storedFileService.requestReplacedDeletion(tx, oldPngId, keep.pngId);
  await storedFileService.requestDeletion(tx, { eventId, kind: 'DESIGN_ASSET', status: 'ATTACHED', id: { notIn: keep.assetIds } });
};

const isEventsAsset = (file: StoredFile | undefined, eventId: string): boolean =>
  !!file && file.kind === 'DESIGN_ASSET' && file.status === 'ATTACHED' && file.eventId === eventId;

export const invitationDesignService = {
  // Organiser read: the full row with the organiser's fields, or null when
  // the event has no design yet (the event's plan.settings say whether one
  // can be made).
  getForEvent: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = await eventService.getScopedWithPass(eventId, requestingRole, tenantId);
    const row = await invitationDesignRepository.findActiveWithRender(eventId);
    if (!row) return null;
    return toOrganiserDesign(row, row.kind === 'CANVAS' ? await designPlanFor(event) : null);
  },

  // Create or replace. One active row per event: an existing design is
  // rewritten in place, whichever kind it was. A CANVAS body goes to
  // putCanvas. Only the current image is kept: a NEW upload is accepted
  // through its StoredFile (signed for this event, measured by Cloudinary:
  // over INVITATION_DESIGN_MAX_BYTES it is refused and deleted), and the
  // files it replaces, or switches away from, are requested for deletion in
  // the same transaction as the save.
  put: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: unknown) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && (body as { kind?: unknown }).kind === 'CANVAS') {
      return invitationDesignService.putCanvas(eventId, userId, requestingRole, tenantId, body as Record<string, unknown>);
    }

    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);

    // Only an UPLOAD needs the cloud name; resolved lazily so a template
    // save never depends on Cloudinary being configured.
    const cloudName = body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'UPLOAD'
      ? requireCloudinaryConfig().cloudName
      : '';
    const existing = await invitationDesignRepository.findActiveByEventId(eventId);
    const storedUploadPublicId = existing?.kind === 'UPLOAD' ? existing.cloudinaryPublicId : null;
    const data = assertValidDesignInput(body, { cloudName, tenantId: event.tenantId, eventId, storedUploadPublicId });

    // The file this save keeps: a new upload's, the stored upload's when
    // sent back unchanged, or none for a template.
    const isNewUpload = data.kind === 'UPLOAD' && data.cloudinaryPublicId !== storedUploadPublicId;
    let keptFileId: string | null = null;
    if (isNewUpload) {
      const accepted = await storedFileService.acceptUpload({
        publicId: data.cloudinaryPublicId,
        kind: 'INVITATION_DESIGN',
        resourceType: 'IMAGE',
        tenantId: event.tenantId,
        eventId,
        notFoundMessage: DESIGN_NOT_OURS_MESSAGE,
        tooLarge: (bytes) => new HttpError(
          422,
          `This image is too large (${mb(bytes)}MB). Invitation designs must be ` +
          `${INVITATION_DESIGN_MAX_BYTES / (1024 * 1024)}MB or smaller, so try a JPG or a smaller size.`
        ),
      });
      keptFileId = accepted.file.id;
    } else if (data.kind === 'UPLOAD') {
      keptFileId = existing?.storedFileId ?? null;
    }

    // replaced: the design being overwritten. Switching away from a CANVAS
    // design releases its rendered card and images too.
    const save = (replaced: { id: string; storedFileId: string | null; pngStoredFileId: string | null } | null) =>
      prisma.$transaction(async (tx) => {
        if (isNewUpload && keptFileId) await storedFileService.attach(tx, keptFileId, { eventId });
        const saved = replaced
          ? await invitationDesignRepository.update(replaced.id, userId, data as PutInvitationDesignDto, keptFileId, tx)
          : await invitationDesignRepository.create(eventId, userId, data as PutInvitationDesignDto, keptFileId, tx);
        await storedFileService.requestReplacedDeletion(tx, replaced?.storedFileId ?? null, keptFileId);
        await releaseCanvasFiles(tx, eventId, replaced?.pngStoredFileId ?? null, { pngId: null, assetIds: [] });
        return toOrganiserDesign(saved, null);
      });

    if (existing) return save(existing);

    try {
      return await save(null);
    } catch (err) {
      // Two first saves raced; the other request created the row between
      // our read and our write. Last write wins, same as two sequential
      // PUTs would, and the winner's image is then the one replaced.
      if (!isActiveDesignUniqueViolation(err)) throw err;
      const winner = await invitationDesignRepository.findActiveByEventId(eventId);
      if (!winner) throw err;
      return save(winner);
    }
  },

  // A CANVAS save (STEERING "Invitation designs"). In order:
  //  1. the event's plan has invitationDesignsEnabled (else 422
  //     INVITATION_DESIGNS_NOT_ON_PLAN);
  //  2. the body's own fields, the document against its allowlist, and the
  //     SVG cleaned (what was stripped is logged by kind, never content);
  //  3. every image the document uses is this event's (already the design's,
  //     or a new upload accepted through its StoredFile), and the rendered
  //     card is a new upload of this event, PNG or WebP, 1080 wide and the
  //     format's height (or the stored one, sent back unchanged);
  //  4. under the event's write lock: the files attached, the row written,
  //     and what the design no longer uses requested for deletion.
  // Cloudinary is asked about new files before the lock, never while
  // holding it.
  putCanvas: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: Record<string, unknown>) => {
    const event = await eventService.getScopedWithPass(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);
    const plan = await assertCanvasDesignsOnPlan(event);

    const input = assertCanvasBody(body);
    const { cloudName } = requireCloudinaryConfig();
    const doc = assertValidCanvasDocument(input.document, designImageContext(cloudName, event.tenantId, eventId));
    const cleaned = cleanCanvasSvg(input.svg, { format: input.format, allowedImageUrls: new Set(doc.imageUrls), hasRsvpButton: doc.hasRsvpButton });
    if (cleaned.stripped.length > 0) {
      // Kinds only (element and attribute names), never the content.
      console.warn(`[invitation-design] cleaned the SVG of a design for event ${eventId}; stripped: ${cleaned.stripped.join(', ')}`);
    }

    // ── New files, measured before the lock ──
    const known = new Map(
      (await invitationDesignRepository.findFilesByPublicIds([...doc.imagePublicIds, input.pngPublicId])).map((f) => [f.publicId, f])
    );
    const accepted = new Set<string>();
    for (const publicId of doc.imagePublicIds) {
      if (isEventsAsset(known.get(publicId), eventId)) continue;
      const { file } = await storedFileService.acceptUpload({
        publicId,
        kind: 'DESIGN_ASSET',
        resourceType: 'IMAGE',
        tenantId: event.tenantId,
        eventId,
        notFoundMessage: ASSET_NOT_OURS_MESSAGE,
        tooLarge: (bytes) => new HttpError(
          422,
          `One of this design's images is too large (${mb(bytes)}MB). Images must be ${DESIGN_ASSET_MAX_BYTES / (1024 * 1024)}MB or smaller.`
        ),
      });
      accepted.add(file.id);
    }

    const existing = await invitationDesignRepository.findActiveByEventId(eventId);
    const sentPng = known.get(input.pngPublicId);
    const pngUnchanged = !!sentPng && existing?.kind === 'CANVAS' && existing.pngStoredFileId === sentPng.id && sentPng.status === 'ATTACHED';
    if (!pngUnchanged) {
      const { file, image } = await storedFileService.acceptUpload({
        publicId: input.pngPublicId,
        kind: 'DESIGN_RENDER',
        resourceType: 'IMAGE',
        tenantId: event.tenantId,
        eventId,
        notFoundMessage: RENDER_NOT_OURS_MESSAGE,
        measureImage: true,
        tooLarge: renderTooLarge,
      });
      assertRenderFits(image, input.format);
      accepted.add(file.id);
    }

    const write = () => eventRepository.withEventWriteLock(eventId, async (tx) => {
      const current = await invitationDesignRepository.findActiveByEventId(eventId, tx);
      // Read again under the lock: a save in between may have released an
      // image this one meant to keep.
      const files = new Map(
        (await invitationDesignRepository.findFilesByPublicIds([...doc.imagePublicIds, input.pngPublicId], tx)).map((f) => [f.publicId, f])
      );

      const assetIds: string[] = [];
      for (const publicId of doc.imagePublicIds) {
        const file = files.get(publicId);
        if (file && isEventsAsset(file, eventId)) {
          assetIds.push(file.id);
        } else if (file && accepted.has(file.id)) {
          await storedFileService.attach(tx, file.id, { eventId });
          assetIds.push(file.id);
        } else {
          throw uploadNotFound(ASSET_NOT_OURS_MESSAGE);
        }
      }

      const png = files.get(input.pngPublicId);
      if (!png) throw uploadNotFound(RENDER_NOT_OURS_MESSAGE);
      const keepsStoredPng = current?.kind === 'CANVAS' && current.pngStoredFileId === png.id && png.status === 'ATTACHED';
      if (!keepsStoredPng) {
        if (!accepted.has(png.id)) throw uploadNotFound(RENDER_NOT_OURS_MESSAGE);
        await storedFileService.attach(tx, png.id, { eventId });
      }

      const columns: CanvasDesignColumns = {
        kind: 'CANVAS',
        format: input.format,
        document: doc.document,
        documentVersion: input.documentVersion,
        svgMarkup: cleaned.svg,
        pngStoredFileId: png.id,
        envelopeColor: input.envelopeColor,
        sealColor: input.sealColor,
        altText: input.altText,
        hasRsvpButton: doc.hasRsvpButton,
      };
      const saved = current
        ? await invitationDesignRepository.update(current.id, userId, columns, null, tx)
        : await invitationDesignRepository.create(eventId, userId, columns, null, tx);

      // Switching from an upload releases its image; the rendered card and
      // images this design no longer uses go too.
      await storedFileService.requestReplacedDeletion(tx, current?.storedFileId ?? null, null);
      await releaseCanvasFiles(tx, eventId, current?.pngStoredFileId ?? null, { pngId: png.id, assetIds });
      return saved;
    });

    let saved;
    try {
      saved = await write();
    } catch (err) {
      // A template-engine save (which doesn't take the lock) created the
      // row between our read and our write: write again, over it.
      if (!isActiveDesignUniqueViolation(err)) throw err;
      saved = await write();
    }
    return toOrganiserDesign(saved, plan);
  },

  // Reset to default: the active design (any kind) is archived and its
  // files requested for deletion. Allowed on every plan, so an organiser
  // whose plan no longer has designs can always go back to the default.
  reset: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<null> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);
    await eventRepository.withEventWriteLock(eventId, async (tx) => {
      const current = await invitationDesignRepository.findActiveByEventId(eventId, tx);
      if (!current) return;
      await invitationDesignRepository.archive(current.id, userId, tx);
      await storedFileService.requestReplacedDeletion(tx, current.storedFileId, null);
      await releaseCanvasFiles(tx, eventId, current.pngStoredFileId, { pngId: null, assetIds: [] });
    });
    return null;
  },

  // Signed direct-to-Cloudinary upload for the organiser's own design,
  // into this event's own folder with a server-chosen public_id, its
  // StoredFile written first (storedFileService.signUpload). The signature
  // is the constraint: the client cannot change folder, public_id or
  // formats without breaking it.
  requestUploadSignature: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<UploadSignatureResponse> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);
    // event.tenantId, never the caller's: correct for a SUPER_ADMIN (who
    // has none) and identical for everyone else, since getScoped already
    // refused any other tenant's event.
    return storedFileService.signUpload({ kind: 'INVITATION_DESIGN', tenantId: event.tenantId, eventId, uploadedBy: { userId } });
  },

  // A CANVAS design's uploads: an image to place in it (purpose ASSET:
  // DESIGN_ASSET, at most 10MB, WebP, JPG or PNG) or its rendered card
  // (purpose RENDER: DESIGN_RENDER, at most 5MB, PNG or WebP). Needs the
  // plan setting, like saving.
  requestCanvasUploadSignature: async (
    eventId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    body: unknown
  ): Promise<UploadSignatureResponse> => {
    const event = await eventService.getScopedWithPass(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);
    await assertCanvasDesignsOnPlan(event);
    const purpose = body && typeof body === 'object' ? (body as { purpose?: unknown }).purpose : undefined;
    if (purpose !== 'ASSET' && purpose !== 'RENDER') {
      throw new HttpError(422, "Say what the upload is for: purpose 'ASSET' (an image for the design) or 'RENDER' (the design's picture).", CANVAS_ERROR_CODES.UPLOAD_PURPOSE_INVALID);
    }
    return storedFileService.signUpload({
      kind: purpose === 'ASSET' ? 'DESIGN_ASSET' : 'DESIGN_RENDER',
      tenantId: event.tenantId,
      eventId,
      uploadedBy: { userId },
    });
  },

  // Start from a starter design (STEERING "Invitation designs: starter
  // designs"): the organiser's own copy, its images copied into this event's
  // unsaved files and its document pointing at them. Saves nothing: the
  // organiser edits it and saves through PUT, like any CANVAS design. Needs
  // the plan setting, like saving.
  startFromStarter: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: unknown) => {
    const event = await eventService.getScopedWithPass(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);
    await assertCanvasDesignsOnPlan(event);
    const starterId = body && typeof body === 'object' ? (body as { starterId?: unknown }).starterId : undefined;
    return invitationStarterService.copyToEvent(starterId, { id: eventId, tenantId: event.tenantId }, userId);
  },
};
