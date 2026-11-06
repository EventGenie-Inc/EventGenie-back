import crypto from 'crypto';
import { type Prisma, type StoredFile, type StoredFileKind, type StoredFileResourceType } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { signCloudinaryParams } from '../../shared/cloudinary/cloudinary-signature.util.js';
import { explicitResource, requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import {
  EVENT_COVER_ALLOWED_FORMATS,
  EVENT_COVER_MAX_BYTES,
  FEEDBACK_LOGO_ALLOWED_FORMATS,
  FEEDBACK_LOGO_MAX_BYTES,
  GUEST_DOCUMENT_MAX_BYTES,
  INVITATION_DESIGN_ALLOWED_FORMATS,
  INVITATION_DESIGN_MAX_BYTES,
  MEMORY_ITEM_IMAGE_ALLOWED_FORMATS,
  MEMORY_ITEM_IMAGE_MAX_BYTES,
  MEMORY_ITEM_VIDEO_ALLOWED_FORMATS,
  MEMORY_ITEM_VIDEO_MAX_BYTES,
} from '../upload/upload-constants.js';
import { eventFileFolder, feedbackLogoFolder, tenantCoverFolder } from '../upload/upload-folders.js';
import { type UploadSignatureResponse } from '../upload/upload.types.js';
import { storedFileRepository, type NewStoredFile } from './stored-file.repository.js';
import { STORAGE_ERROR_CODES } from './stored-file.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  STORED FILES (STEERING "Storage")
//
//  One row per file this app puts in Cloudinary, written when the upload is
//  SIGNED. That is what makes every file deletable: an upload whose save
//  never happens still has a row, and the unsaved-uploads sweep deletes it.
//
//  - SIGNING (signUpload) chooses the folder from the owner alone
//    (upload-folders.ts) and records who asked.
//  - SAVING (acceptUpload) accepts a client-reported public id only through
//    its row: signed by this server, of this kind, for this tenant and
//    event, not yet used. Its size is Cloudinary's, never the browser's.
//    Too large: refused, and the file requested for deletion.
//  - ATTACHING (attach) ties it to its owner, conditionally, so one upload
//    can't be saved twice.
//  - DELETING is only ever a request (requestDeletion), recorded in the
//    same transaction as the change that made the file unwanted (a
//    replacement saved, an event deleted). The worker does the deleting
//    (storage-deletion.worker.ts).
// ─────────────────────────────────────────

export const UNSAVED_UPLOAD_AFTER_MS = 24 * 60 * 60 * 1000;

const RESOURCE_TYPE: Record<StoredFileResourceType, 'image' | 'video' | 'raw'> = { IMAGE: 'image', VIDEO: 'video', RAW: 'raw' };

// The most a file of each kind may be: checked against Cloudinary's own
// figure at save, and when its notification arrives.
export const maxBytesFor = (kind: StoredFileKind, resourceType: StoredFileResourceType): number => {
  switch (kind) {
    case 'COVER': return EVENT_COVER_MAX_BYTES;
    case 'INVITATION_DESIGN': return INVITATION_DESIGN_MAX_BYTES;
    case 'FEEDBACK_LOGO': return FEEDBACK_LOGO_MAX_BYTES;
    case 'GUEST_DOCUMENT': return GUEST_DOCUMENT_MAX_BYTES;
    case 'MEMORY_ITEM': return resourceType === 'VIDEO' ? MEMORY_ITEM_VIDEO_MAX_BYTES : MEMORY_ITEM_IMAGE_MAX_BYTES;
  }
};

export type UploadedBy = { userId: string } | { inviteId: string };

export interface SignUploadInput {
  kind: Exclude<StoredFileKind, 'GUEST_DOCUMENT'>;
  tenantId: string;
  // The event the file belongs to; null only for a cover whose event
  // doesn't exist yet. A feedback logo names its feedback's event, though
  // it is stored in the tenant's folder.
  eventId: string | null;
  mediaType?: 'IMAGE' | 'VIDEO';
  uploadedBy: UploadedBy;
}

const signingSpec = (input: SignUploadInput): { folder: string; resourceType: StoredFileResourceType; allowedFormats: string } => {
  const { kind, tenantId, eventId } = input;
  const needEvent = (): string => {
    if (!eventId) throw new Error(`An event is required to sign a ${kind} upload`);
    return eventId;
  };
  switch (kind) {
    case 'COVER':
      return { folder: eventId ? eventFileFolder(tenantId, eventId, 'COVER') : tenantCoverFolder(tenantId), resourceType: 'IMAGE', allowedFormats: EVENT_COVER_ALLOWED_FORMATS };
    case 'MEMORY_ITEM':
      return input.mediaType === 'VIDEO'
        ? { folder: eventFileFolder(tenantId, needEvent(), 'MEMORY_ITEM'), resourceType: 'VIDEO', allowedFormats: MEMORY_ITEM_VIDEO_ALLOWED_FORMATS }
        : { folder: eventFileFolder(tenantId, needEvent(), 'MEMORY_ITEM'), resourceType: 'IMAGE', allowedFormats: MEMORY_ITEM_IMAGE_ALLOWED_FORMATS };
    case 'INVITATION_DESIGN':
      return { folder: eventFileFolder(tenantId, needEvent(), 'INVITATION_DESIGN'), resourceType: 'IMAGE', allowedFormats: INVITATION_DESIGN_ALLOWED_FORMATS };
    case 'FEEDBACK_LOGO':
      return { folder: feedbackLogoFolder(tenantId), resourceType: 'IMAGE', allowedFormats: FEEDBACK_LOGO_ALLOWED_FORMATS };
  }
};

// Cloudinary's signed upload notification (storage.router.ts), when this
// environment can be reached from Cloudinary. Signed with every upload, so
// the browser can't drop it. Unset (local development; or until the
// frontend posts every field in `params`): sizes come from an explicit
// call at save instead.
const notificationUrl = (): string | null => {
  const url = process.env.STORAGE_NOTIFICATION_URL?.trim();
  return url ? url : null;
};

const DEFAULT_NOT_FOUND_MESSAGE = "This upload couldn't be found. Please upload the file again.";

// Every save refusal for an upload that isn't this owner's, or was never
// uploaded: 422 UPLOAD_NOT_FOUND, whatever the route; only the words are
// the route's own.
export const uploadNotFound = (message: string = DEFAULT_NOT_FOUND_MESSAGE): HttpError =>
  new HttpError(422, message, STORAGE_ERROR_CODES.UPLOAD_NOT_FOUND);

const uploadNotReady = (): HttpError =>
  new HttpError(503, "We couldn't check your upload just now. Please try again in a moment.", STORAGE_ERROR_CODES.UPLOAD_NOT_READY);

export interface AcceptUploadInput {
  publicId: unknown;
  kind: StoredFileKind;
  resourceType: StoredFileResourceType;
  tenantId: string;
  // The event it is being saved to; null for a cover saved to a draft or a
  // new event's cover, which must then have been signed without one.
  eventId: string | null;
  // A wizard draft saving or materialising: a cover already ATTACHED to
  // this draft is accepted too.
  draftId?: string | null;
  // The route's own words for an upload that isn't this owner's or was never
  // uploaded; the refusal is always 422 UPLOAD_NOT_FOUND.
  notFoundMessage?: string;
  // The route's own refusal for a file over its kind's limit.
  tooLarge: (bytes: number) => HttpError;
}

export interface AcceptedUpload {
  file: StoredFile;
  bytes: number;
}

const belongsTo = (file: StoredFile, input: AcceptUploadInput): boolean => {
  if (file.kind !== input.kind || file.tenantId !== input.tenantId || file.resourceType !== input.resourceType) return false;
  const usable = file.status === 'SIGNED' || file.status === 'UPLOADED' || (file.status === 'ATTACHED' && !!input.draftId && file.draftId === input.draftId);
  if (!usable) return false;
  // A cover signed before its event existed may be saved to any event of
  // its tenant; every other file only to the event it was signed for.
  if (input.kind === 'COVER') return file.eventId === null || file.eventId === input.eventId;
  return file.eventId === input.eventId;
};

export const storedFileService = {
  // ── Signing ─────────────────────────────

  signUpload: async (input: SignUploadInput, db: Db = prisma): Promise<UploadSignatureResponse> => {
    const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();
    const { folder, resourceType, allowedFormats } = signingSpec(input);
    const uuid = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const notify = notificationUrl();

    // The row first: a file can't reach Cloudinary without one.
    await storedFileRepository.create({
      publicId: `${folder}/${uuid}`,
      resourceType,
      deliveryType: 'UPLOAD',
      kind: input.kind,
      tenantId: input.tenantId,
      eventId: input.eventId,
      uploadedByUserId: 'userId' in input.uploadedBy ? input.uploadedBy.userId : null,
      uploadedByInviteId: 'inviteId' in input.uploadedBy ? input.uploadedBy.inviteId : null,
    }, db);

    const signed: Record<string, string | number> = {
      allowed_formats: allowedFormats,
      folder,
      public_id: uuid,
      timestamp,
      ...(notify ? { notification_url: notify } : {}),
    };
    const signature = signCloudinaryParams(signed, apiSecret);

    return {
      signature,
      timestamp,
      apiKey,
      cloudName,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${RESOURCE_TYPE[resourceType]}/upload`,
      folder,
      publicId: uuid,
      allowedFormats,
      // Advisory: lets the browser refuse an oversized file before
      // uploading it. The real check is Cloudinary's own figure, at save.
      maxFileSizeBytes: maxBytesFor(input.kind, resourceType),
      // Every field to POST with the file, signed: the browser sends these
      // as they are. New signed fields (notification_url) arrive here
      // without a frontend change.
      params: {
        ...Object.fromEntries(Object.entries(signed).map(([k, v]) => [k, String(v)])),
        api_key: apiKey,
        signature,
      },
    };
  },

  // ── Saving ──────────────────────────────

  // The file behind a client-reported public id, with its real size, or a
  // refusal. Over its kind's limit: requested for deletion, then refused
  // with the caller's own error. Never deleted for any other refusal: a
  // file this check doesn't accept is not this request's to delete.
  acceptUpload: async (input: AcceptUploadInput, now: Date = new Date()): Promise<AcceptedUpload> => {
    const notFound = (): HttpError => uploadNotFound(input.notFoundMessage);
    if (typeof input.publicId !== 'string' || !input.publicId) throw notFound();
    const file = await storedFileRepository.findByPublicId(input.publicId);
    if (!file || !belongsTo(file, input)) throw notFound();

    let bytes = file.bytes;
    if (bytes === null) {
      const measured = await explicitResource(file.publicId, RESOURCE_TYPE[file.resourceType], file.deliveryType === 'PRIVATE' ? 'private' : 'upload');
      if (!measured.ok && measured.notFound) {
        // Signed but never uploaded (or already gone): nothing to save.
        await storedFileRepository.requestDeletion({ id: file.id }, now);
        throw notFound();
      }
      if (!measured.ok) {
        console.error(`[storage] couldn't measure ${file.id}: ${measured.reason}`);
        throw uploadNotReady();
      }
      bytes = measured.bytes;
      await storedFileRepository.recordMeasured(file.id, bytes, measured.format, now);
    }

    if (bytes > maxBytesFor(file.kind, file.resourceType)) {
      await storedFileRepository.requestDeletion({ id: file.id }, now);
      throw input.tooLarge(bytes);
    }
    return { file: { ...file, bytes }, bytes };
  },

  // Ties an accepted file to its owner, inside the owner's own write. A
  // file used or released since it was accepted: the save is refused (and
  // rolled back with the transaction).
  attach: async (
    db: Db,
    fileId: string,
    owner: { eventId: string | null; draftId?: string | null; fromDraftId?: string | null },
    now: Date = new Date()
  ): Promise<void> => {
    const attached = await storedFileRepository.attach(fileId, { eventId: owner.eventId, draftId: owner.draftId ?? null, fromDraftId: owner.fromDraftId ?? null }, now, db);
    if (!attached) {
      throw new HttpError(409, 'This upload has already been saved.', STORAGE_ERROR_CODES.UPLOAD_ALREADY_USED);
    }
  },

  // ── Files this server uploads itself (guest documents) ──

  // The row, before the file is sent (SIGNED: not yet confirmed there).
  recordServerUpload: (data: NewStoredFile, db: Db = prisma): Promise<StoredFile> => storedFileRepository.create(data, db),

  // Its size, as Cloudinary confirmed it.
  recordMeasured: (db: Db, id: string, bytes: number, format: string | null, now: Date = new Date()): Promise<void> =>
    storedFileRepository.recordMeasured(id, bytes, format, now, db),

  // ── Deleting ────────────────────────────

  // Recorded, never done here: the worker deletes. Pass the transaction of
  // the change that made the files unwanted, so the two land together.
  requestDeletion: (db: Db, where: Prisma.StoredFileWhereInput, now: Date = new Date()): Promise<number> =>
    storedFileRepository.requestDeletion(where, now, db),

  // The file a record named before it was replaced (an old cover, design or
  // logo): requested for deletion, unless it is the file now kept.
  requestReplacedDeletion: async (db: Db, oldFileId: string | null | undefined, keptFileId: string | null | undefined, now: Date = new Date()): Promise<void> => {
    if (!oldFileId || oldFileId === keptFileId) return;
    await storedFileRepository.requestDeletion({ id: oldFileId }, now, db);
  },

  // POST /api/storage/files/release (and the guest's): the uploader drops
  // an upload they never saved (picked another cover, removed it from the
  // queue). Only their own, only while SIGNED or UPLOADED; anything else is
  // the same 404, so the answer never says whose a file is. Releasing again
  // is a no-op. Returns the released file's id, for an immediate delete.
  release: async (by: UploadedBy, publicId: unknown, now: Date = new Date()): Promise<string> => {
    const notFound = new HttpError(404, "This upload couldn't be found.", STORAGE_ERROR_CODES.UPLOAD_NOT_FOUND);
    if (typeof publicId !== 'string' || !publicId) throw notFound;
    const file = await storedFileRepository.findByPublicId(publicId);
    const mine = !!file && ('userId' in by ? file.uploadedByUserId === by.userId : file.uploadedByInviteId === by.inviteId);
    if (!file || !mine) throw notFound;
    if (file.status === 'DELETE_REQUESTED' || file.status === 'DELETED') return file.id;
    if (file.status !== 'SIGNED' && file.status !== 'UPLOADED') throw notFound;
    await storedFileRepository.requestDeletion({ id: file.id, status: { in: ['SIGNED', 'UPLOADED'] } }, now);
    return file.id;
  },

  // Uploads never saved within 24 hours. A guest document with its
  // GuestDocument row is the documents sweep's (guest-document.service.ts);
  // one that never got a row (its upload or its row failed) is this one's.
  sweepUnsaved: (now: Date = new Date()): Promise<number> =>
    storedFileRepository.requestDeletion(
      { status: { in: ['SIGNED', 'UPLOADED'] }, signedAt: { lt: new Date(now.getTime() - UNSAVED_UPLOAD_AFTER_MS) }, guestDocument: { is: null } },
      now
    ),

  // ── Cloudinary's upload notification ───

  // Already signature-checked (storage.router.ts). Records the real size of
  // a file still SIGNED; one over its kind's limit is requested for
  // deletion at once, before anyone tries to save it. Anything else (an
  // unknown public id, another kind of notification) is acknowledged and
  // ignored, so Cloudinary stops retrying.
  handleUploadNotification: async (body: unknown, now: Date = new Date()): Promise<'recorded' | 'too_large' | 'ignored'> => {
    if (!body || typeof body !== 'object') return 'ignored';
    const n = body as { notification_type?: unknown; public_id?: unknown; bytes?: unknown; format?: unknown };
    if (n.notification_type !== 'upload' || typeof n.public_id !== 'string' || typeof n.bytes !== 'number') return 'ignored';
    const file = await storedFileRepository.findByPublicId(n.public_id);
    if (!file || file.status !== 'SIGNED') return 'ignored';
    await storedFileRepository.recordMeasured(file.id, n.bytes, typeof n.format === 'string' ? n.format : null, now);
    if (n.bytes > maxBytesFor(file.kind, file.resourceType)) {
      await storedFileRepository.requestDeletion({ id: file.id }, now);
      return 'too_large';
    }
    return 'recorded';
  },
};
