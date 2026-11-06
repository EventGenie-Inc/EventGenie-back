import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { assertMemoryHubAccessible, assertMemoryHubQuotaAvailable } from '../memory-hub/memory-hub-tier-enforcement.util.js';
import { assertMemoryItemMediaTypeAvailable } from '../memory-hub/memory-item-limits.util.js';
import { storedFileService, type UploadedBy } from '../storage/stored-file.service.js';
import { type RequestUploadSignatureDto, type UploadSignatureResponse } from './upload.types.js';

// ─────────────────────────────────────────
//  UPLOAD SERVICE
//
//  Issues short-lived, purpose-scoped signatures for direct browser ->
//  Cloudinary uploads. Files never pass through this backend.
//
//  Every signature writes the file's StoredFile row first
//  (storedFileService.signUpload): the folder and public_id are chosen
//  here from the owner alone, and signed, so the browser can't change
//  them. Cloudinary's raw signed-upload API can't carry a byte limit, so
//  size is checked at save, against Cloudinary's own figure for the file
//  (storedFileService.acceptUpload), never the browser's.
// ─────────────────────────────────────────

// One signing implementation for the organiser path (requestSignature
// below) and the guest path (memory-hub.service.ts's
// requestGuestUploadSignature, after invite-token validation instead).
export const signMemoryItemUpload = (
  tenantId: string,
  eventId: string,
  mediaType: 'IMAGE' | 'VIDEO',
  uploadedBy: UploadedBy
): Promise<UploadSignatureResponse> =>
  storedFileService.signUpload({ kind: 'MEMORY_ITEM', tenantId, eventId, mediaType, uploadedBy });

export const uploadService = {
  requestSignature: async (
    requestingRole: PlatformRole,
    requestingTenantId: string | null,
    data: RequestUploadSignatureDto,
    userId: string
  ): Promise<UploadSignatureResponse> => {
    if (data.purpose === 'MEMORY_ITEM') {
      return uploadService.requestOrganiserMemoryItemSignature(requestingRole, requestingTenantId, data, userId);
    }
    if (data.purpose !== 'EVENT_COVER') {
      throw new HttpError(400, `Unknown upload purpose '${data.purpose as string}'`);
    }

    // An existing event's cover goes in that event's folder; a new event's
    // (the wizard, before the event exists) in the tenant's cover folder,
    // its StoredFile tied to the event when the event is created.
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

    return storedFileService.signUpload({
      kind: 'COVER',
      tenantId,
      eventId: data.eventId ?? null,
      uploadedBy: { userId },
    });
  },

  // ORGANISER path — authenticated (Firebase + session), EVENT_ADMIN+,
  // tenant-scoped via the normal eventService.getById gate. The GUEST
  // path lives in memory-hub.service.ts's requestGuestUploadSignature,
  // authenticated by invite token instead — see that file for why it
  // can't reuse this same entry point.
  requestOrganiserMemoryItemSignature: async (
    requestingRole: PlatformRole,
    requestingTenantId: string | null,
    data: RequestUploadSignatureDto,
    userId: string
  ): Promise<UploadSignatureResponse> => {
    if (!data.eventId) {
      throw new HttpError(400, 'eventId is required for a Memory Hub upload');
    }
    if (data.mediaType !== 'IMAGE' && data.mediaType !== 'VIDEO') {
      throw new HttpError(400, "mediaType ('IMAGE' or 'VIDEO') is required for a Memory Hub upload");
    }

    let tenantId: string;
    let event;
    if (requestingRole === 'SUPER_ADMIN') {
      event = await eventService.getById(data.eventId, 'SUPER_ADMIN', null);
      tenantId = event.tenantId;
    } else {
      if (!requestingTenantId) {
        throw new HttpError(400, 'User has no associated tenant');
      }
      // Captured (this previously discarded the fetched event) — needed
      // below to resolve entitlement (Event Pass batch), not just for
      // the 404s-cross-tenant ownership check it already provided.
      event = await eventService.getById(data.eventId, requestingRole, requestingTenantId);
      tenantId = requestingTenantId;
    }

    // A switched-off feature is refused before any tier check (STEERING
    // "Feature flags"), after the event lookup so another tenant's event is
    // still the same 404.
    assertMemoryItemMediaTypeAvailable(data.mediaType);
    await assertMemoryHubAccessible(event);
    await assertMemoryHubQuotaAvailable(event);

    return signMemoryItemUpload(tenantId, data.eventId, data.mediaType, { userId });
  },
};
