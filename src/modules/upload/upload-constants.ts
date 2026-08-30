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
