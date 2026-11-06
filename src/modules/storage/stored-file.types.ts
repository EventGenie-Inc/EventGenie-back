// Error codes the storage module's refusals carry (HttpError.code).
export const STORAGE_ERROR_CODES = {
  // Not an upload this server signed for this owner, already used or
  // released, or never actually uploaded. Saving: 422. Releasing: 404.
  UPLOAD_NOT_FOUND: 'UPLOAD_NOT_FOUND',
  // Saved twice at once: the other save won. 409.
  UPLOAD_ALREADY_USED: 'UPLOAD_ALREADY_USED',
  // Cloudinary couldn't be asked the file's size just now. 503.
  UPLOAD_NOT_READY: 'UPLOAD_NOT_READY',
} as const;
