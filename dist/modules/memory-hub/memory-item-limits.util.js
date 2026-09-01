import {} from '@prisma/client';
import { MEMORY_ITEM_IMAGE_MAX_BYTES, MEMORY_ITEM_VIDEO_MAX_BYTES } from '../upload/upload-constants.js';
// bytes is transient at the point this is called — reported directly by
// Cloudinary's own upload response, checked here (after the fact,
// same reasoning as event-cover-image.util.ts) before the row is ever
// persisted. Not signable into the upload itself; see the batch report.
export const isMemoryItemTooLarge = (mediaType, bytes) => bytes > (mediaType === 'VIDEO' ? MEMORY_ITEM_VIDEO_MAX_BYTES : MEMORY_ITEM_IMAGE_MAX_BYTES);
export const memoryItemTooLargeMessage = (mediaType, bytes) => {
    const limitBytes = mediaType === 'VIDEO' ? MEMORY_ITEM_VIDEO_MAX_BYTES : MEMORY_ITEM_IMAGE_MAX_BYTES;
    const kind = mediaType === 'VIDEO' ? 'video' : 'photo';
    return `This ${kind} is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). ${kind === 'video' ? 'Videos' : 'Photos'} must be ${Math.round(limitBytes / (1024 * 1024))}MB or smaller.`;
};
//# sourceMappingURL=memory-item-limits.util.js.map