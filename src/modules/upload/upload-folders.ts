// ─────────────────────────────────────────
//  UPLOAD FOLDERS — where this server signs each kind of upload, and the
//  checks that a stored publicId is in its owner's folder.
//
//  Every signed upload gets a server-chosen public_id (a random UUID)
//  inside a folder that names its owner. Cloudinary reports the stored
//  public_id back as `<folder>/<uuid>`, and the browser passes that to us
//  when saving. That value is CLIENT-SUPPLIED. A NEW upload is accepted
//  only through its StoredFile row (storage/stored-file.service.ts's
//  acceptUpload): signed by this server, for this exact tenant, event and
//  kind, not yet attached. An id ALREADY stored on a record (a purge, a
//  download, a document link) is checked against its owner's folders here
//  before it is ever sent to Cloudinary. Otherwise anyone who can read a
//  Cloudinary URL (every guest can) could have this server delete, or
//  claim, another event's or another tenant's asset with our API secret.
//
//  Signing (storage/stored-file.service.ts's signUpload, and documents)
//  and checking both build folders here, so the two can never disagree.
//
//  Dependency-free, like upload-constants.ts, to stay out of import cycles.
// ─────────────────────────────────────────

// ─────────────────────────────────────────
//  THE ENVIRONMENT — the first segment of every new path
//
//  STORAGE_ENV names the environment whose files these are: dev, staging
//  or prod. Required: server.ts refuses to start without a valid one
//  (assertStorageEnvValid), and signing refuses too, so no file is ever
//  stored without it. Dev and staging share one Cloudinary account; the
//  prefix is what tells their files apart (prod has its own account).
// ─────────────────────────────────────────
export const STORAGE_ENVS = ['dev', 'staging', 'prod'] as const;
export type StorageEnv = (typeof STORAGE_ENVS)[number];

export const storageEnv = (): StorageEnv => {
  const value = process.env.STORAGE_ENV;
  if (!(STORAGE_ENVS as readonly string[]).includes(value ?? '')) {
    throw new Error(`STORAGE_ENV must be one of ${STORAGE_ENVS.join(', ')} (got ${value ? `'${value}'` : 'nothing'}).`);
  }
  return value as StorageEnv;
};

export const assertStorageEnvValid = (): void => {
  storageEnv();
};

// ─────────────────────────────────────────
//  PATHS FOR NEW UPLOADS (STEERING "Storage: paths")
//
//    <env>/t/<tenantId>/e/<eventId>/<kind>/<uuid>   an event's files
//    <env>/t/<tenantId>/<kind>/<uuid>               a tenant's own files
//
//  Fixed by who owns the file, never by what else exists. A cover
//  uploaded before its event exists (the wizard, a new event) goes in the
//  tenant's cover folder; its StoredFile row ties it to the event once
//  the event is created. Deleting never reads a folder: only records.
// ─────────────────────────────────────────
export const EVENT_FILE_SEGMENTS = {
  COVER: 'cover',
  MEMORY_ITEM: 'memory',
  INVITATION_DESIGN: 'design',
  GUEST_DOCUMENT: 'document',
} as const;

export type EventFileKind = keyof typeof EVENT_FILE_SEGMENTS;

export const environmentPrefix = (): string => `${storageEnv()}/`;

export const eventFileFolder = (tenantId: string, eventId: string, kind: EventFileKind): string =>
  `${storageEnv()}/t/${tenantId}/e/${eventId}/${EVENT_FILE_SEGMENTS[kind]}`;

// A cover not yet on an event.
export const tenantCoverFolder = (tenantId: string): string => `${storageEnv()}/t/${tenantId}/cover`;

// A company logo given with an event's feedback: the company's, not the event's.
export const feedbackLogoFolder = (tenantId: string): string => `${storageEnv()}/t/${tenantId}/feedback-logo`;

export const memoryHubFolder = (tenantId: string, eventId: string): string => eventFileFolder(tenantId, eventId, 'MEMORY_ITEM');
export const invitationDesignFolder = (tenantId: string, eventId: string): string => eventFileFolder(tenantId, eventId, 'INVITATION_DESIGN');
// Uploaded by this server itself (never signed for a browser) as private raw assets.
export const guestDocumentFolder = (tenantId: string, eventId: string): string => eventFileFolder(tenantId, eventId, 'GUEST_DOCUMENT');

// ─────────────────────────────────────────
//  LEGACY PATHS — where every file stored before 2026-11 lives. Never
//  signed for again, and no file is moved: an id already stored in one of
//  these is still accepted wherever a stored id is checked (the purge, the
//  download, documents), through the *Folders lists below.
// ─────────────────────────────────────────
export const legacyCoverFolder = (tenantId: string): string => `eventgenie/${tenantId}/covers`;
export const legacyMemoryHubFolder = (tenantId: string, eventId: string): string => `eventgenie/${tenantId}/memory-hub/${eventId}`;
export const legacyInvitationDesignFolder = (tenantId: string, eventId: string): string => `eventgenie/${tenantId}/invitation-designs/${eventId}`;
export const legacyFeedbackLogoFolder = (tenantId: string): string => `eventgenie/${tenantId}/feedback-logos`;
export const legacyGuestDocumentFolder = (tenantId: string, eventId: string): string => `eventgenie/${tenantId}/documents/${eventId}`;
export const LEGACY_PREFIX = 'eventgenie/';

// Every folder a stored id of that kind may be in: this environment's, then the legacy one.
export const memoryHubFolders = (tenantId: string, eventId: string): string[] => [memoryHubFolder(tenantId, eventId), legacyMemoryHubFolder(tenantId, eventId)];
export const invitationDesignFolders = (tenantId: string, eventId: string): string[] => [invitationDesignFolder(tenantId, eventId), legacyInvitationDesignFolder(tenantId, eventId)];
export const guestDocumentFolders = (tenantId: string, eventId: string): string[] => [guestDocumentFolder(tenantId, eventId), legacyGuestDocumentFolder(tenantId, eventId)];

// crypto.randomUUID() output: lowercase hex, version 4.
export const SIGNED_PUBLIC_ID_UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Exactly `<folder>/<uuid>`: nothing before, nothing after, no extra path
// segments, so neither "../" tricks nor a sibling folder can match.
export const isSignedPublicIdInFolder = (publicId: unknown, folder: string): publicId is string =>
  typeof publicId === 'string' && new RegExp(`^${escapeRegExp(folder)}/${SIGNED_PUBLIC_ID_UUID_PATTERN}$`).test(publicId);

export const isSignedPublicIdInAnyFolder = (publicId: unknown, folders: string[]): publicId is string =>
  folders.some((folder) => isSignedPublicIdInFolder(publicId, folder));

// A document's public id: `<folder>/<uuid>/<safe name>.<ext>`. The last
// segment is the guest's file name reduced to safe characters
// (guest-document-content.util.ts's safeDownloadName), because Cloudinary
// names a downloaded file after it. Checked like isSignedPublicIdInFolder
// before any delete.
export const isGuestDocumentPublicIdInFolder = (publicId: unknown, folder: string): publicId is string =>
  typeof publicId === 'string' &&
  new RegExp(`^${escapeRegExp(folder)}/${SIGNED_PUBLIC_ID_UUID_PATTERN}/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.(?:pdf|jpg|png|xlsx)$`).test(publicId);

export const isGuestDocumentPublicIdInAnyFolder = (publicId: unknown, folders: string[]): publicId is string =>
  folders.some((folder) => isGuestDocumentPublicIdInFolder(publicId, folder));

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
