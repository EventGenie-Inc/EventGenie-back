// ─────────────────────────────────────────
//  UPLOAD FOLDERS — where this server signs each kind of upload, and the
//  check that a client-reported publicId really is one it signed there.
//
//  Every signed upload gets a server-chosen public_id (a random UUID)
//  inside a folder that names its owner. Cloudinary reports the stored
//  public_id back as `<folder>/<uuid>`, and the browser passes that to us
//  when saving. That value is CLIENT-SUPPLIED: before it is stored, or
//  handed to destroyAsset, it must be checked against the folder this
//  server would have signed for that exact owner. Otherwise anyone who can
//  read a Cloudinary URL (every guest can, and the publicId is in the URL)
//  could have this server delete, or claim, another event's or another
//  tenant's asset, using our API secret.
//
//  Signing (upload.service.ts, invitation-design.service.ts) and checking
//  (event covers, Memory Hub items, invitation designs) both build folders
//  here, so the two can never disagree.
//
//  Dependency-free, like upload-constants.ts, to stay out of import cycles.
// ─────────────────────────────────────────

// Tenant-wide, not per event: a cover is uploaded in the wizard before the
// event (and its id) exists.
export const coverFolder = (tenantId: string): string => `eventgenie/${tenantId}/covers`;

export const memoryHubFolder = (tenantId: string, eventId: string): string =>
  `eventgenie/${tenantId}/memory-hub/${eventId}`;

export const invitationDesignFolder = (tenantId: string, eventId: string): string =>
  `eventgenie/${tenantId}/invitation-designs/${eventId}`;

// crypto.randomUUID() output: lowercase hex, version 4.
export const SIGNED_PUBLIC_ID_UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Exactly `<folder>/<uuid>`: nothing before, nothing after, no extra path
// segments, so neither "../" tricks nor a sibling folder can match.
export const isSignedPublicIdInFolder = (publicId: unknown, folder: string): publicId is string =>
  typeof publicId === 'string' && new RegExp(`^${escapeRegExp(folder)}/${SIGNED_PUBLIC_ID_UUID_PATTERN}$`).test(publicId);

// The URL a stored record displays must be OUR account's Cloudinary
// delivery URL for exactly the publicId that was checked above, or the
// check proves nothing: the record would hold a vetted publicId while
// showing a URL that points anywhere, including off Cloudinary.
// res.cloudinary.com is shared by every Cloudinary customer, so the cloud
// name in the path is what makes it ours. Matches Cloudinary's secure_url
// shape, https://res.cloudinary.com/<cloud>/<image|video>/upload/v<n>/<publicId>.<ext>,
// with an optional version and no transformation segment: the stored URL
// is the original, and delivery transforms are added by the frontend.
// Call only after isSignedPublicIdInFolder has accepted `publicId`.
export const isCloudinaryDeliveryUrlFor = (
  url: unknown,
  expected: { cloudName: string; resourceType: 'image' | 'video'; publicId: string; extensions: readonly string[] }
): url is string => {
  if (typeof url !== 'string') return false;
  const extensions = expected.extensions.map(escapeRegExp).join('|');
  return new RegExp(
    `^https://res\\.cloudinary\\.com/${escapeRegExp(expected.cloudName)}/${expected.resourceType}/upload/(?:v\\d+/)?` +
    `${escapeRegExp(expected.publicId)}\\.(?:${extensions})$`
  ).test(url);
};
