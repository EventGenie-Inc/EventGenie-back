import { type MediaType, type PlatformRole } from '@prisma/client';
import { memoryHubService } from './memory-hub.service.js';
import { eventService } from '../event/event.service.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { isSignedPublicIdInFolder, memoryHubFolder } from '../upload/upload-folders.js';
import { isMemoryHubVideoEnabled } from './memory-item-limits.util.js';
import {
  CLOUDINARY_ARCHIVE_MAX_FILES,
  archivePublicIdQueryLength,
  buildArchiveDownloadUrl,
} from '../../shared/cloudinary/cloudinary-archive.util.js';

// ─────────────────────────────────────────
//  DOWNLOAD ALL — every approved Memory Hub item as zip files
//
//  POST /api/events/:eventId/memory-hub/download, behind `memoryHubDownload`.
//  Returns signed, short-lived Cloudinary archive URLs (download mode): the
//  browser fetches each zip straight from Cloudinary, built from the
//  originals, so nothing passes through this server.
//
//  What goes in: the event's live (not archived) APPROVED items, named by
//  their exact public ids, never by folder prefix (the folder also holds
//  pending and rejected uploads). Videos only while `memoryHubVideo` is on.
//
//  Parts: one archive holds one resource type, so photos and videos are
//  separate parts, photos first, each in the order they were taken. A part
//  closes at whichever comes first:
//   - 1,000 files, Cloudinary's documented per-archive limit;
//   - 95 MB of originals (the sizes Cloudinary reported at upload), under
//     its documented minimum archive limit of 100 MB, with room for the zip's
//     own headers;
//   - a 12,000-character URL. Each public id is in the URL, and Cloudinary's
//     API refuses a request line past about 16 KB with a 414 (measured on
//     2026-10-15: 110 ids, a 16,336-character URL, worked; 112 ids, 16,628,
//     were refused). At ~136 characters per id this is what actually binds:
//     about 80 photos a part.
//  A single item larger than the size budget (a video near its 100 MB
//  upload limit) goes in a part of its own.
//
//  Names: each zip is "<event name> photos, part N of M" made file-safe.
//  Inside it, every file is its public id's last segment (a random UUID)
//  at the root of the zip: Cloudinary's archive API has no per-file name,
//  only the original upload filename (whatever the guest's phone called
//  it, never checked, so not safe to use) or the public id.
//
//  Links last 30 minutes (DOWNLOAD_LINK_TTL_MS). Every fetch of a link
//  builds the zip again at Cloudinary's cost, so a link should be dead
//  well before it can be forwarded and reused, yet live long enough to
//  start every part on a slow connection: Cloudinary checks the expiry when
//  a download starts, and a download already running finishes. Generating
//  links is rate limited per event (memoryHubDownloadLimiter).
// ─────────────────────────────────────────

export const DOWNLOAD_LINK_TTL_MS = 30 * 60 * 1000;
export const ARCHIVE_PART_MAX_BYTES = 95 * 1024 * 1024;
export const ARCHIVE_URL_MAX_LENGTH = 12_000;
// The URL before any public id: endpoint, the signed scalars, api key and
// signature. Measured at well under 600 characters; 1,000 is the margin.
const ARCHIVE_URL_BASE_ALLOWANCE = 1000;

export const MEMORY_HUB_NOTHING_TO_DOWNLOAD = 'MEMORY_HUB_NOTHING_TO_DOWNLOAD';

export interface ArchiveItem {
  cloudinaryPublicId: string;
  mediaType: MediaType;
  bytes: number;
  createdAt: Date;
}

export interface DownloadPart {
  part: number;
  partCount: number;
  mediaType: MediaType;
  itemCount: number;
  bytes: number;
  fileName: string;
  url: string;
}

export interface DownloadAllResult {
  itemCount: number;
  photoCount: number;
  videoCount: number;
  expiresAt: string;
  parts: DownloadPart[];
}

// Pure: groups items (already in order) into parts no larger than any of
// the three limits above.
export const packArchiveParts = <T extends { cloudinaryPublicId: string; bytes: number }>(items: T[]): T[][] => {
  const parts: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  let urlLength = ARCHIVE_URL_BASE_ALLOWANCE;
  for (const item of items) {
    const itemUrlLength = archivePublicIdQueryLength(item.cloudinaryPublicId);
    const full =
      current.length >= CLOUDINARY_ARCHIVE_MAX_FILES ||
      bytes + item.bytes > ARCHIVE_PART_MAX_BYTES ||
      urlLength + itemUrlLength > ARCHIVE_URL_MAX_LENGTH;
    if (full && current.length > 0) {
      parts.push(current);
      current = [];
      bytes = 0;
      urlLength = ARCHIVE_URL_BASE_ALLOWANCE;
    }
    current.push(item);
    bytes += item.bytes;
    urlLength += itemUrlLength;
  }
  if (current.length > 0) parts.push(current);
  return parts;
};

// The event's name, reduced to letters, digits, spaces and hyphens, with
// anything that could be an email address or a phone number dropped (an
// organiser can type anything into a name), at most 60 characters.
export const archiveNameFor = (eventName: string, kind: 'photos' | 'videos', part: number, partCount: number): string => {
  const safeName = eventName
    .split(/\s+/)
    .filter((word) => !word.includes('@'))
    .join(' ')
    .replace(/\d[\d\s()+-]{4,}\d/g, ' ')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 -]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${safeName || 'event'}-${kind}${partCount > 1 ? `-part-${part}-of-${partCount}` : ''}`;
};

export const memoryHubDownloadService = {
  downloadAll: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<DownloadAllResult> => {
    // The organiser gate every Memory Hub route uses: the event (tenant
    // scope and the assignment lock), the plan's Memory Hub, the hub itself.
    // An archived event too: downloading is how its organisers keep the
    // photos before they are purged (media-retention.service.ts). Purged
    // items are archived, so they are never in a zip.
    const hub = await memoryHubService.getByEventId(eventId, requestingRole, tenantId, false, { archivedEvent: true });
    const event = await eventService.getById(eventId, requestingRole, tenantId, true);

    // The hub's live items, filtered to approved ones in this event's own
    // folder (every stored id was checked on the way in; this keeps an older
    // row from ever putting another folder's asset in a zip we sign).
    const folder = memoryHubFolder(event.tenantId, event.id);
    const allowed: MediaType[] = isMemoryHubVideoEnabled() ? ['IMAGE', 'VIDEO'] : ['IMAGE'];
    const items: ArchiveItem[] = hub.memoryItems
      .filter((item) => item.status === 'APPROVED' && !item.isArchived && allowed.includes(item.mediaType))
      .filter((item) => isSignedPublicIdInFolder(item.cloudinaryPublicId, folder))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.cloudinaryPublicId.localeCompare(b.cloudinaryPublicId));

    if (items.length === 0) {
      throw new HttpError(
        422,
        "There are no approved photos to download yet. Approve guests' photos in the Memory Hub, then try again.",
        MEMORY_HUB_NOTHING_TO_DOWNLOAD
      );
    }

    const photos = packArchiveParts(items.filter((i) => i.mediaType === 'IMAGE'));
    const videos = packArchiveParts(items.filter((i) => i.mediaType === 'VIDEO'));
    const expiresAt = new Date(Date.now() + DOWNLOAD_LINK_TTL_MS);

    const build = (groups: ArchiveItem[][], kind: 'photos' | 'videos', mediaType: MediaType, offset: number, partCount: number) =>
      groups.map((group, i): DownloadPart => {
        const fileName = archiveNameFor(event.name, kind, i + 1, groups.length);
        return {
          part: offset + i + 1,
          partCount,
          mediaType,
          itemCount: group.length,
          bytes: group.reduce((sum, item) => sum + item.bytes, 0),
          fileName: `${fileName}.zip`,
          url: buildArchiveDownloadUrl({
            resourceType: mediaType === 'VIDEO' ? 'video' : 'image',
            publicIds: group.map((item) => item.cloudinaryPublicId),
            targetPublicId: fileName,
            expiresAt,
          }),
        };
      });

    const partCount = photos.length + videos.length;
    const photoCount = items.filter((i) => i.mediaType === 'IMAGE').length;
    return {
      itemCount: items.length,
      photoCount,
      videoCount: items.length - photoCount,
      expiresAt: expiresAt.toISOString(),
      parts: [...build(photos, 'photos', 'IMAGE', 0, partCount), ...build(videos, 'videos', 'VIDEO', photos.length, partCount)],
    };
  },
};
