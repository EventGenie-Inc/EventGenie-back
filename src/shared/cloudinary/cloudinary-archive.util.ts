import { requireCloudinaryConfig } from './cloudinary.client.js';
import { signCloudinaryParams } from './cloudinary-signature.util.js';

// ─────────────────────────────────────────
//  CLOUDINARY ARCHIVE DOWNLOAD URL
//
//  A signed, time-limited generate_archive URL in `download` mode: the
//  browser fetches it from Cloudinary, Cloudinary builds the zip from the
//  originals and streams it straight back. Nothing passes through this
//  server and nothing is stored in Cloudinary. The same URL the SDKs'
//  download_archive_url builds, without the SDK (same reasoning as
//  cloudinary-signature.util.ts): every parameter except api_key and
//  resource_type is signed, an array signed as its values joined with ","
//  and sent as repeated `name[]` query parameters.
//
//  Cloudinary's documented limits (generate_archive reference): at most
//  1,000 assets per archive, and an archive no larger than 100 MB or the
//  account's raw file size limit, whichever is larger. One archive holds one
//  resource type, so images and videos are separate archives. Each fetch
//  of the URL builds the archive again (it isn't cached), and counts
//  against the account's usage each time. Free Cloudinary accounts can't
//  deliver archives at all.
// ─────────────────────────────────────────

export const CLOUDINARY_ARCHIVE_MAX_FILES = 1000;

export interface ArchiveDownloadUrlInput {
  resourceType: 'image' | 'video';
  publicIds: string[];
  // The downloaded file's name, without ".zip".
  targetPublicId: string;
  expiresAt: Date;
}

const archiveEndpoint = (cloudName: string, resourceType: string): string =>
  `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/generate_archive`;

// The query-string cost of one public id, for packing parts under a URL
// length budget before any URL is built.
export const archivePublicIdQueryLength = (publicId: string): number =>
  `&${encodeURIComponent('public_ids[]')}=${encodeURIComponent(publicId)}`.length;

export const buildArchiveDownloadUrl = (input: ArchiveDownloadUrlInput, now: Date = new Date()): string => {
  const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();

  const scalars: Record<string, string | number> = {
    mode: 'download',
    target_format: 'zip',
    target_public_id: input.targetPublicId,
    // Every file at the root of the zip, named by its own id: no
    // tenant/event folder path inside the archive.
    flatten_folders: 'true',
    // An asset gone from Cloudinary (removed by hand, say) leaves that file
    // out instead of failing the whole part.
    allow_missing: 'true',
    expires_at: Math.floor(input.expiresAt.getTime() / 1000),
    timestamp: Math.floor(now.getTime() / 1000),
  };
  const signature = signCloudinaryParams({ ...scalars, public_ids: input.publicIds.join(',') }, apiSecret);

  const query = [
    ...Object.entries(scalars).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`),
    ...input.publicIds.map((id) => `${encodeURIComponent('public_ids[]')}=${encodeURIComponent(id)}`),
    `api_key=${encodeURIComponent(apiKey)}`,
    `signature=${signature}`,
  ].join('&');

  return `${archiveEndpoint(cloudName, input.resourceType)}?${query}`;
};
