import { EVENT_COVER_MAX_BYTES } from '../upload/upload-constants.js';
import { coverFolder, isSignedPublicIdInFolder } from '../upload/upload-folders.js';
import { HttpError } from '../../shared/errors/http-error.js';
// A client-reported coverImagePublicId must be one this server signed for
// THIS tenant's cover folder (upload-folders.ts's header explains why), or
// it is refused with a 422 and nothing is destroyed. Checked BEFORE the
// size check below, whose rejection path destroys the asset: an unchecked
// id there let any organiser have this server delete another tenant's
// image. It is also what gets destroyed later when the cover is replaced,
// so it must be checked before it is ever stored.
//
// null/undefined (no Cloudinary cover, or a pasted external link) is not a
// publicId and passes. The caller skips the check when the id is the one
// already stored on the event, so re-saving an event with an older,
// pre-existing cover never starts failing.
export const assertCoverPublicIdOwned = (tenantId, publicId) => {
    if (publicId === undefined || publicId === null)
        return;
    if (!isSignedPublicIdInFolder(publicId, coverFolder(tenantId))) {
        throw new HttpError(422, "This cover image wasn't uploaded for your account. Upload it again from the event form.");
    }
};
// coverImageBytes is a transient, request-only field — Cloudinary
// reports it directly in the browser's OWN upload response, and the
// frontend passes it through when saving the event. It is never
// persisted (see event.repository.ts). This is the only way this
// backend learns the uploaded file's real size: Cloudinary's raw
// signed-upload API has no signable byte-limit parameter (verified
// against current docs — only an upload PRESET can carry one), so this
// check runs after the fact, at save time, rather than being baked into
// the signature itself. See the batch report for the full reasoning.
export const isCoverImageTooLarge = (bytes) => bytes !== undefined && bytes !== null && bytes > EVENT_COVER_MAX_BYTES;
export const coverImageTooLargeMessage = (bytes) => `This image is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). Cover images must be ${EVENT_COVER_MAX_BYTES / (1024 * 1024)}MB or smaller.`;
//# sourceMappingURL=event-cover-image.util.js.map