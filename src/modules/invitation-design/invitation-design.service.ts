import { type PlatformRole } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { INVITATION_DESIGN_MAX_BYTES } from '../upload/upload-constants.js';
import { type UploadSignatureResponse } from '../upload/upload.types.js';
import { storedFileService } from '../storage/stored-file.service.js';
import { invitationDesignRepository, isActiveDesignUniqueViolation } from './invitation-design.repository.js';
import { assertValidDesignInput } from './invitation-design-validation.util.js';
import { type PutInvitationDesignDto } from './invitation-design.types.js';

// ─────────────────────────────────────────
//  INVITATION DESIGN SERVICE
//
//  Transitive tenant scoping, as for every event sub-resource: each method
//  gates on eventService.getScoped (the lean ownership lookup), which 404s
//  another tenant's event exactly like a missing one. SUPER_ADMIN passes
//  through unscoped, as everywhere.
//
//  No tier gating in v1: every plan gets templates and uploads.
// ─────────────────────────────────────────

// The same words the validator uses for an image signed for another event.
const DESIGN_NOT_OURS_MESSAGE = "This image wasn't uploaded for this event. Upload it again from this event's design page.";

const assertEventEditable = (status: string): void => {
  if (status === 'CANCELLED') {
    throw new HttpError(409, "This event has been cancelled, so its invitation design can't be changed.");
  }
};

export const invitationDesignService = {
  // Organiser read: the full row, or null when the event has no design yet.
  getForEvent: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getScoped(eventId, requestingRole, tenantId);
    return invitationDesignRepository.findActiveByEventId(eventId);
  },

  // Create or replace. One active row per event: an existing design is
  // rewritten in place, whichever kind it was. Only the current image is
  // kept: a NEW upload is accepted through its StoredFile (signed for this
  // event, measured by Cloudinary: over INVITATION_DESIGN_MAX_BYTES it is
  // refused and deleted), and the image it replaces, or switches away
  // from, is requested for deletion in the same transaction as the save.
  put: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: unknown) => {
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
          `This image is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). Invitation designs must be ` +
          `${INVITATION_DESIGN_MAX_BYTES / (1024 * 1024)}MB or smaller, so try a JPG or a smaller size.`
        ),
      });
      keptFileId = accepted.file.id;
    } else if (data.kind === 'UPLOAD') {
      keptFileId = existing?.storedFileId ?? null;
    }

    const save = (targetId: string | null, replacedFileId: string | null) =>
      prisma.$transaction(async (tx) => {
        if (isNewUpload && keptFileId) await storedFileService.attach(tx, keptFileId, { eventId });
        const saved = targetId
          ? await invitationDesignRepository.update(targetId, userId, data as PutInvitationDesignDto, keptFileId, tx)
          : await invitationDesignRepository.create(eventId, userId, data as PutInvitationDesignDto, keptFileId, tx);
        await storedFileService.requestReplacedDeletion(tx, replacedFileId, keptFileId);
        return saved;
      });

    if (existing) return save(existing.id, existing.storedFileId);

    try {
      return await save(null, null);
    } catch (err) {
      // Two first saves raced; the other request created the row between
      // our read and our write. Last write wins, same as two sequential
      // PUTs would, and the winner's image is then the one replaced.
      if (!isActiveDesignUniqueViolation(err)) throw err;
      const winner = await invitationDesignRepository.findActiveByEventId(eventId);
      if (!winner) throw err;
      return save(winner.id, winner.storedFileId);
    }
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
};
