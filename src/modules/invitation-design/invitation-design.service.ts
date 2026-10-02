import crypto from 'crypto';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { signCloudinaryParams } from '../../shared/cloudinary/cloudinary-signature.util.js';
import { requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { INVITATION_DESIGN_ALLOWED_FORMATS, INVITATION_DESIGN_MAX_BYTES } from '../upload/upload-constants.js';
import { type UploadSignatureResponse } from '../upload/upload.types.js';
import { invitationDesignRepository, isActiveDesignUniqueViolation } from './invitation-design.repository.js';
import { assertValidDesignInput } from './invitation-design-validation.util.js';
import { invitationDesignFolder } from '../upload/upload-folders.js';

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
  // rewritten in place, whichever kind it was. A replaced upload stays in
  // Cloudinary on purpose (no hard delete, see the batch report).
  put: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: unknown) => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);

    // Only an UPLOAD needs the cloud name; resolved lazily so a template
    // save never depends on Cloudinary being configured.
    const cloudName = body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'UPLOAD'
      ? requireCloudinaryConfig().cloudName
      : '';
    const existing = await invitationDesignRepository.findActiveByEventId(eventId);
    const data = assertValidDesignInput(body, {
      cloudName,
      tenantId: event.tenantId,
      eventId,
      storedUploadPublicId: existing?.kind === 'UPLOAD' ? existing.cloudinaryPublicId : null,
    });

    if (existing) return invitationDesignRepository.update(existing.id, userId, data);

    try {
      return await invitationDesignRepository.create(eventId, userId, data);
    } catch (err) {
      // Two first saves raced; the other request created the row between
      // our read and our write. Last write wins, same as two sequential
      // PUTs would.
      if (!isActiveDesignUniqueViolation(err)) throw err;
      const winner = await invitationDesignRepository.findActiveByEventId(eventId);
      if (!winner) throw err;
      return invitationDesignRepository.update(winner.id, userId, data);
    }
  },

  // Signed direct-to-Cloudinary upload for the organiser's own design,
  // into this event's own folder with a server-chosen public_id. The
  // signature is the constraint (see cloudinary-signature.util.ts): the
  // client cannot change folder, public_id or formats without breaking it.
  // Size cannot be signed, so it is checked on PUT from the reported bytes.
  requestUploadSignature: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<UploadSignatureResponse> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertEventEditable(event.status);

    const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    // event.tenantId, never the caller's: correct for a SUPER_ADMIN (who
    // has none) and identical for everyone else, since getScoped already
    // refused any other tenant's event.
    const folder = invitationDesignFolder(event.tenantId, eventId);
    const publicId = crypto.randomUUID();

    const signature = signCloudinaryParams(
      { allowed_formats: INVITATION_DESIGN_ALLOWED_FORMATS, folder, public_id: publicId, timestamp },
      apiSecret
    );

    return {
      signature,
      timestamp,
      apiKey,
      cloudName,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      folder,
      publicId,
      allowedFormats: INVITATION_DESIGN_ALLOWED_FORMATS,
      maxFileSizeBytes: INVITATION_DESIGN_MAX_BYTES,
    };
  },
};
