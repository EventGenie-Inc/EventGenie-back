import crypto from 'crypto';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { signCloudinaryParams } from '../../shared/cloudinary/cloudinary-signature.util.js';
import { requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { eventService } from '../event/event.service.js';
import {
  EVENT_COVER_ALLOWED_FORMATS,
  EVENT_COVER_MAX_BYTES,
  MEMORY_ITEM_IMAGE_ALLOWED_FORMATS,
  MEMORY_ITEM_IMAGE_MAX_BYTES,
  MEMORY_ITEM_VIDEO_ALLOWED_FORMATS,
  MEMORY_ITEM_VIDEO_MAX_BYTES,
} from './upload-constants.js';
import { assertMemoryHubAccessible, assertMemoryHubQuotaAvailable } from '../memory-hub/memory-hub-tier-enforcement.util.js';
import { type RequestUploadSignatureDto, type UploadSignatureResponse } from './upload.types.js';

// ─────────────────────────────────────────
//  UPLOAD SERVICE
//
//  Issues short-lived, purpose-scoped signatures for direct browser ->
//  Cloudinary uploads. Files never pass through this backend.
//
//  Signed parameters (the actual constraint — see cloudinary-signature
//  util's docs on why signing = enforcement): folder, allowed_formats,
//  public_id, timestamp. NOT signed: max file size — Cloudinary's raw
//  signed-upload API has no signable byte-limit parameter (verified
//  against current docs; only an upload PRESET can carry one, which
//  would mean provisioning preset infrastructure for one field). Size is
//  instead enforced after the fact, at save time — event/event-cover-image.util.ts
//  for covers, memory-hub.service.ts for Memory Hub items.
// ─────────────────────────────────────────

// One signing implementation, shared by the organiser path below (called
// from requestSignature, after the usual Firebase+session auth and
// tenant-scoped event lookup) AND the guest path (memory-hub.service.ts's
// requestGuestUploadSignature, called after invite-token validation
// instead) — "do not build a second upload path" means one signing
// mechanism serving both auth stories, not that both stories collapse
// into one code path; guests were never going to pass through
// requireEventAdmin.
export const signMemoryItemUpload = (tenantId: string, eventId: string, mediaType: 'IMAGE' | 'VIDEO'): UploadSignatureResponse => {
  const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  // Scoped per EVENT, not just per tenant — unlike a cover (one per
  // event, uploaded before the event even exists), Memory Hub items are
  // many, always belong to an existing event, and should sit in their
  // own per-event folder rather than pooling every tenant event's
  // memories together in one tenant-wide bucket.
  const folder = `eventgenie/${tenantId}/memory-hub/${eventId}`;
  const publicId = crypto.randomUUID();
  const resourceType = mediaType === 'VIDEO' ? 'video' : 'image';
  const allowedFormats = mediaType === 'VIDEO' ? MEMORY_ITEM_VIDEO_ALLOWED_FORMATS : MEMORY_ITEM_IMAGE_ALLOWED_FORMATS;
  const maxFileSizeBytes = mediaType === 'VIDEO' ? MEMORY_ITEM_VIDEO_MAX_BYTES : MEMORY_ITEM_IMAGE_MAX_BYTES;

  const signature = signCloudinaryParams(
    { allowed_formats: allowedFormats, folder, public_id: publicId, timestamp },
    apiSecret
  );

  return {
    signature,
    timestamp,
    apiKey,
    cloudName,
    // Resource type changes the upload URL itself, exactly like it does
    // the destroy URL in cloudinary.client.ts — video and image are
    // different endpoints in Cloudinary's API, not a query parameter.
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
    folder,
    publicId,
    allowedFormats,
    maxFileSizeBytes,
  };
};

export const uploadService = {
  requestSignature: async (
    requestingRole: PlatformRole,
    requestingTenantId: string | null,
    data: RequestUploadSignatureDto
  ): Promise<UploadSignatureResponse> => {
    if (data.purpose === 'MEMORY_ITEM') {
      return uploadService.requestOrganiserMemoryItemSignature(requestingRole, requestingTenantId, data);
    }
    if (data.purpose !== 'EVENT_COVER') {
      throw new HttpError(400, `Unknown upload purpose '${data.purpose as string}'`);
    }

    // Folder is scoped by TENANT, not by event — a cover is uploaded
    // during event CREATION, before the event (and its id) exist, so the
    // folder can't depend on eventId for the common case.
    let tenantId: string;
    if (requestingRole === 'SUPER_ADMIN') {
      // A Super Admin has no tenantId of their own (same situation as
      // event.service.ts's tier checks) — eventId is the only way to
      // know which tenant's folder to scope this upload into.
      if (!data.eventId) {
        throw new HttpError(400, 'eventId is required for a Super Admin upload, to determine which tenant owns the folder.');
      }
      const event = await eventService.getById(data.eventId, 'SUPER_ADMIN', null);
      tenantId = event.tenantId;
    } else {
      if (!requestingTenantId) {
        throw new HttpError(400, 'User has no associated tenant');
      }
      tenantId = requestingTenantId;
      // Ownership sanity-check when editing an EXISTING event's cover —
      // 404s on a cross-tenant eventId rather than letting it pass
      // silently. Skipped when eventId is absent, since a brand-new
      // event being created in the wizard has no id yet.
      if (data.eventId) {
        await eventService.getById(data.eventId, requestingRole, requestingTenantId);
      }
    }

    const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `eventgenie/${tenantId}/covers`;
    // Generated server-side, not client-chosen — signed alongside folder
    // so the client has no way to influence the destination path via a
    // crafted public_id (e.g. one containing '../') without invalidating
    // the signature.
    const publicId = crypto.randomUUID();

    const signature = signCloudinaryParams(
      { allowed_formats: EVENT_COVER_ALLOWED_FORMATS, folder, public_id: publicId, timestamp },
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
      allowedFormats: EVENT_COVER_ALLOWED_FORMATS,
      // Advisory only — lets the frontend reject an oversized file before
      // even attempting the upload. Not cryptographically enforced by
      // Cloudinary (see module doc comment); the real enforcement is
      // server-side at save time.
      maxFileSizeBytes: EVENT_COVER_MAX_BYTES,
    };
  },

  // ORGANISER path — authenticated (Firebase + session), EVENT_ADMIN+,
  // tenant-scoped via the normal eventService.getById gate. The GUEST
  // path lives in memory-hub.service.ts's requestGuestUploadSignature,
  // authenticated by invite token instead — see that file for why it
  // can't reuse this same entry point.
  requestOrganiserMemoryItemSignature: async (
    requestingRole: PlatformRole,
    requestingTenantId: string | null,
    data: RequestUploadSignatureDto
  ): Promise<UploadSignatureResponse> => {
    if (!data.eventId) {
      throw new HttpError(400, 'eventId is required for a Memory Hub upload');
    }
    if (data.mediaType !== 'IMAGE' && data.mediaType !== 'VIDEO') {
      throw new HttpError(400, "mediaType ('IMAGE' or 'VIDEO') is required for a Memory Hub upload");
    }

    let tenantId: string;
    if (requestingRole === 'SUPER_ADMIN') {
      const event = await eventService.getById(data.eventId, 'SUPER_ADMIN', null);
      tenantId = event.tenantId;
    } else {
      if (!requestingTenantId) {
        throw new HttpError(400, 'User has no associated tenant');
      }
      await eventService.getById(data.eventId, requestingRole, requestingTenantId); // 404s cross-tenant
      tenantId = requestingTenantId;
    }

    await assertMemoryHubAccessible(tenantId);
    await assertMemoryHubQuotaAvailable(data.eventId, tenantId);

    return signMemoryItemUpload(tenantId, data.eventId, data.mediaType);
  },
};
