import { EVENT_COVER_MAX_BYTES } from '../upload/upload-constants.js';

// coverImageBytes is a transient, request-only field — Cloudinary
// reports it directly in the browser's OWN upload response, and the
// frontend passes it through when saving the event. It is never
// persisted (see event.repository.ts). This is the only way this
// backend learns the uploaded file's real size: Cloudinary's raw
// signed-upload API has no signable byte-limit parameter (verified
// against current docs — only an upload PRESET can carry one), so this
// check runs after the fact, at save time, rather than being baked into
// the signature itself. See the batch report for the full reasoning.
export const isCoverImageTooLarge = (bytes: number | null | undefined): bytes is number =>
  bytes !== undefined && bytes !== null && bytes > EVENT_COVER_MAX_BYTES;

export const coverImageTooLargeMessage = (bytes: number): string =>
  `This image is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). Cover images must be ${EVENT_COVER_MAX_BYTES / (1024 * 1024)}MB or smaller.`;
