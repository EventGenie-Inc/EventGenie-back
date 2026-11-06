import { type Prisma } from '@prisma/client';
import { EVENT_COVER_ALLOWED_FORMATS, EVENT_COVER_MAX_BYTES } from '../upload/upload-constants.js';
import { isCloudinaryDeliveryUrlFor } from '../upload/upload-folders.js';
import { requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { storedFileService } from '../storage/stored-file.service.js';

// ─────────────────────────────────────────
//  EVENT COVERS — one file kept per event (STEERING "Storage")
//
//  A cover from our uploader is a StoredFile, signed for this tenant
//  (upload.service.ts): into the event's own folder when the event exists,
//  else the tenant's cover folder, tied to the event when it is created.
//  A client-reported coverImagePublicId is accepted only through that row
//  (storedFileService.acceptUpload): this tenant's, a cover, not yet used,
//  and for this event or for none. Its size is Cloudinary's own: over
//  EVENT_COVER_MAX_BYTES it is refused (400) and requested for deletion.
//  Never trusted from the browser (coverImageBytes is ignored).
//
//  Replacing or clearing a cover requests the old one's deletion in the
//  same transaction as the save (applyCoverChange), so only the current
//  cover is ever kept. An id already stored on the event, sent back
//  unchanged, is not checked again. null/undefined, or a pasted external
//  link with no public id, is not one of our files.
//
//  The URL stored beside a cover's public id is what every guest and every
//  email loads, so it must be our delivery URL for exactly that public id
//  (isCloudinaryDeliveryUrlFor), as for Memory Hub items, designs and
//  logos: checked whenever either changes, before anything else, so a
//  mismatched pair is refused (422) with nothing requested for deletion.
// ─────────────────────────────────────────

export const coverImageTooLargeMessage = (bytes: number): string =>
  `This image is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). Cover images must be ${EVENT_COVER_MAX_BYTES / (1024 * 1024)}MB or smaller.`;

const COVER_URL_MISMATCH_MESSAGE = "This cover image's link must be the one our uploader returned for it. Upload it again from the event form.";
const COVER_URL_EXTENSIONS = [...EVENT_COVER_ALLOWED_FORMATS.split(','), 'jpeg'];

export const assertCoverUrlMatches = (coverImageUrl: unknown, publicId: string): void => {
  if (!isCloudinaryDeliveryUrlFor(coverImageUrl, {
    cloudName: requireCloudinaryConfig().cloudName,
    resourceType: 'image',
    publicId,
    extensions: COVER_URL_EXTENSIONS,
  })) {
    throw new HttpError(422, COVER_URL_MISMATCH_MESSAGE);
  }
};

const COVER_NOT_OURS_MESSAGE = "This cover image wasn't uploaded for your account. Upload it again from the event form.";

// A new cover's StoredFile id, once accepted. eventId: the event it is
// being saved to (null for a new event); draftId: a wizard draft that may
// already hold it.
export const acceptCover = async (
  tenantId: string,
  eventId: string | null,
  publicId: string,
  coverImageUrl: unknown,
  draftId: string | null = null
): Promise<string> => {
  assertCoverUrlMatches(coverImageUrl, publicId);
  const { file } = await storedFileService.acceptUpload({
    publicId,
    kind: 'COVER',
    resourceType: 'IMAGE',
    tenantId,
    eventId,
    draftId,
    notFoundMessage: COVER_NOT_OURS_MESSAGE,
    tooLarge: (bytes) => new HttpError(400, coverImageTooLargeMessage(bytes)),
  });
  return file.id;
};

// What an event save does to its cover file: the file kept (a new one to
// attach, or null when cleared or replaced by an external link) and the one
// it replaces. null when the cover doesn't change.
export interface CoverChange {
  newFileId: string | null;
  oldFileId: string | null;
}

export const planCoverChange = async (
  event: { id: string; tenantId: string; coverImageUrl: string | null; coverImagePublicId: string | null; coverFileId: string | null },
  data: { coverImageUrl?: string | null; coverImagePublicId?: string | null }
): Promise<CoverChange | null> => {
  const { coverImagePublicId } = data;
  if (coverImagePublicId === undefined || coverImagePublicId === event.coverImagePublicId) {
    // The file stays; only its link may change, and an uploaded cover's
    // link must still be its own.
    if (data.coverImageUrl !== undefined && data.coverImageUrl !== event.coverImageUrl && event.coverFileId && event.coverImagePublicId) {
      assertCoverUrlMatches(data.coverImageUrl, event.coverImagePublicId);
    }
    return null;
  }
  // A new cover's link is checked against it; one that leaves the link
  // as it is must already be its own.
  const url = data.coverImageUrl !== undefined ? data.coverImageUrl : event.coverImageUrl;
  const newFileId = coverImagePublicId === null ? null : await acceptCover(event.tenantId, event.id, coverImagePublicId, url);
  return { newFileId, oldFileId: event.coverFileId };
};

// Inside the save's own transaction: the new cover attached to the event,
// the event pointing at it, and the replaced one requested for deletion.
export const applyCoverChange = async (tx: Prisma.TransactionClient, eventId: string, change: CoverChange): Promise<void> => {
  if (change.newFileId) await storedFileService.attach(tx, change.newFileId, { eventId });
  await tx.event.update({ where: { id: eventId }, data: { coverFileId: change.newFileId } });
  await storedFileService.requestReplacedDeletion(tx, change.oldFileId, change.newFileId);
};
