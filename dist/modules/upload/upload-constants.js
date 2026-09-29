// Deliberately dependency-free (no eventService import) — both
// upload.service.ts and event/event-cover-image.util.ts need these
// values, and event.service.ts imports the latter, so keeping them here
// avoids upload.service.ts <-> event.service.ts becoming a real import
// cycle (upload.service.ts already imports eventService the other way,
// for the SUPER_ADMIN tenant-resolution case).
// A cover is a single hero/banner image. 5MB comfortably covers an
// uncompressed phone-camera JPEG (commonly 3-8MB straight off a modern
// phone, though most sharing flows downscale before that point) while
// keeping per-event storage cost predictable. Memory Hub (Batch C —
// much higher volume, video included) will set its own limit rather
// than inherit this one.
export const EVENT_COVER_MAX_BYTES = 5 * 1024 * 1024;
export const EVENT_COVER_ALLOWED_FORMATS = 'jpg,png,webp';
// ─────────────────────────────────────────
//  INVITATION DESIGN (organiser's own uploaded design)
//
//  10MB — double a cover. An uploaded design is a finished graphic
//  exported from Canva/Photoshop, usually as PNG, and often at print
//  resolution (A5 at 300dpi is 1748x2480): a text-and-illustration PNG
//  at that size is commonly 2-6MB and a photo-heavy one can pass 8MB,
//  where a cover is typically a phone JPEG. Asking an organiser to
//  re-export smaller costs them more than one image per event costs us,
//  and guests never download the original: delivery goes through
//  Cloudinary's resizing (f_auto/q_auto/w_), as the gallery already does.
//  Above 10MB the file is almost certainly an unflattened or oversized
//  export the organiser should fix anyway.
// ─────────────────────────────────────────
export const INVITATION_DESIGN_MAX_BYTES = 10 * 1024 * 1024;
export const INVITATION_DESIGN_ALLOWED_FORMATS = 'jpg,png,webp';
// ─────────────────────────────────────────
//  MEMORY HUB
//
//  Image limit: 15MB — a bit more generous than a cover (10-15MB
//  comfortably covers a full-resolution HEIC/JPEG straight off a modern
//  phone, before any client-side compression), since Memory Hub is a
//  gallery of many guest-contributed originals, not one curated hero
//  image.
//
//  Video limit: 100MB — this is not a business choice, it's Cloudinary's
//  own documented ceiling for a single (non-chunked) upload; anything
//  larger requires their `upload_large` chunked-upload flow, a
//  genuinely different multi-request mechanism this batch does not
//  build (see the batch report). 100MB is still generous for a short
//  event clip — a few minutes of compressed 1080p phone video is
//  typically 20-60MB.
// ─────────────────────────────────────────
export const MEMORY_ITEM_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const MEMORY_ITEM_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const MEMORY_ITEM_IMAGE_ALLOWED_FORMATS = 'jpg,png,webp,heic';
export const MEMORY_ITEM_VIDEO_ALLOWED_FORMATS = 'mp4,mov,webm';
// The per-invite guest upload budget — same number as
// memoryHubGuestUploadLimiter's `max` (rate-limit.middleware.ts), which
// imports this rather than the reverse: memory-hub.service.ts's
// getGuestView reports it in limits.uploadRequestsPer5Min so the
// frontend reads the real budget instead of hardcoding it, and a
// service file has no business importing from shared/middleware.
export const MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN = 60;
//# sourceMappingURL=upload-constants.js.map