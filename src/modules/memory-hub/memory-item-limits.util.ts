import { type MediaType } from '@prisma/client';
import {
  MEMORY_ITEM_IMAGE_ALLOWED_FORMATS,
  MEMORY_ITEM_IMAGE_MAX_BYTES,
  MEMORY_ITEM_VIDEO_ALLOWED_FORMATS,
  MEMORY_ITEM_VIDEO_MAX_BYTES,
} from '../upload/upload-constants.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { HttpError } from '../../shared/errors/http-error.js';

export const MEMORY_HUB_VIDEO_UNAVAILABLE = 'MEMORY_HUB_VIDEO_UNAVAILABLE';

// Video in Memory Hub is behind the `memoryHubVideo` flag. Off, no upload
// signature is issued for a video, organiser or guest: 422 with a code, so
// the uploader can tell the person to pick a photo instead. Items already
// uploaded are untouched and still shown.
export const isMemoryHubVideoEnabled = (): boolean => isFeatureEnabled('memoryHubVideo');

export const assertMemoryItemMediaTypeAvailable = (
  mediaType: MediaType,
  audience: 'organiser' | 'guest' = 'organiser'
): void => {
  if (mediaType !== 'VIDEO' || isMemoryHubVideoEnabled()) return;
  throw new HttpError(
    422,
    audience === 'guest'
      ? "Videos can't be added to this photo album right now. You can still add photos."
      : "Video uploads aren't available right now. You can still upload photos.",
    MEMORY_HUB_VIDEO_UNAVAILABLE
  );
};

// The formats a Memory Hub upload may be in right now, images first: what
// guest-view reports, so the picker never offers a file the signature would
// refuse.
export const memoryItemAllowedFormats = (): string =>
  isMemoryHubVideoEnabled()
    ? `${MEMORY_ITEM_IMAGE_ALLOWED_FORMATS},${MEMORY_ITEM_VIDEO_ALLOWED_FORMATS}`
    : MEMORY_ITEM_IMAGE_ALLOWED_FORMATS;

// bytes is transient at the point this is called — reported directly by
// Cloudinary's own upload response, checked here (after the fact,
// same reasoning as event-cover-image.util.ts) before the row is ever
// persisted. Not signable into the upload itself; see the batch report.
export const isMemoryItemTooLarge = (mediaType: MediaType, bytes: number): boolean =>
  bytes > (mediaType === 'VIDEO' ? MEMORY_ITEM_VIDEO_MAX_BYTES : MEMORY_ITEM_IMAGE_MAX_BYTES);

export const memoryItemTooLargeMessage = (mediaType: MediaType, bytes: number): string => {
  const limitBytes = mediaType === 'VIDEO' ? MEMORY_ITEM_VIDEO_MAX_BYTES : MEMORY_ITEM_IMAGE_MAX_BYTES;
  const kind = mediaType === 'VIDEO' ? 'video' : 'photo';
  return `This ${kind} is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). ${kind === 'video' ? 'Videos' : 'Photos'} must be ${Math.round(limitBytes / (1024 * 1024))}MB or smaller.`;
};
