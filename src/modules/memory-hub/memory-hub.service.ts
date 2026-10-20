import { type PlatformRole, type MediaType } from '@prisma/client';
import { memoryHubRepository } from './memory-hub.repository.js';
import {
  type CreateMemoryHubDto,
  type UpdateMemoryHubDto,
  type CreateMemoryItemDto,
  type CreateGuestMemoryItemDto,
  type UpdateMemoryItemDto,
} from './memory-hub.types.js';
import { eventService } from '../event/event.service.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertValidOpensAt } from './memory-hub-validation.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { destroyAsset, requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { isCloudinaryDeliveryUrlFor, isSignedPublicIdInFolder, memoryHubFolder } from '../upload/upload-folders.js';
import { signMemoryItemUpload } from '../upload/upload.service.js';
import {
  assertMemoryHubAccessible,
  assertMemoryHubQuotaAvailable,
  getMemoryHubQuotaBytes,
  isMemoryHubTierEnabled,
} from './memory-hub-tier-enforcement.util.js';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import {
  assertMemoryItemMediaTypeAvailable,
  isMemoryHubVideoEnabled,
  isMemoryItemTooLarge,
  memoryItemAllowedFormats,
  memoryItemTooLargeMessage,
} from './memory-item-limits.util.js';
import { launchLimitMessage, tierRefusalMessage } from '../subscription-tier-config/tier-refusal-wording.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { consentService } from '../consent/consent.service.js';
import { currentConsentWording } from '../consent/consent-wording.js';
import {
  MEMORY_ITEM_IMAGE_MAX_BYTES,
  MEMORY_ITEM_VIDEO_MAX_BYTES,
  MEMORY_ITEM_IMAGE_ALLOWED_FORMATS,
  MEMORY_ITEM_VIDEO_ALLOWED_FORMATS,
  MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN,
} from '../upload/upload-constants.js';

// Guest-originated writes have no platform userId — Invite.updatedBy is
// a plain String (not an FK), same convention as rsvp.service.ts's
// GUEST_ACTOR.
const GUEST_ACTOR = 'guest-memory-upload';

// A guest asked for a video to be shared publicly: the opt-in (and its
// wording, "this photo") is for photos only.
export const PUBLIC_SHARING_PHOTOS_ONLY = 'PUBLIC_SHARING_PHOTOS_ONLY';

const INVALID_INVITE_MESSAGE = "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.";

const assertSharingIsForAPhoto = (mediaType: MediaType): void => {
  if (mediaType !== 'IMAGE') {
    throw new HttpError(422, 'Only photos can be shared publicly, not videos.', PUBLIC_SHARING_PHOTOS_ONLY);
  }
};

// Checked at PERSIST time (after Cloudinary has already reported the
// real byte count) — the pre-signature checks in
// memory-hub-tier-enforcement.util.ts can only catch "already full
// before this upload started"; the exact size of THIS file is
// unknowable until now. An oversized or over-quota upload is destroyed
// from Cloudinary immediately rather than left as an orphan nobody
// ever references — same reasoning as event-cover-image.util.ts.
// The formats each upload was signed for (upload-constants.ts), plus
// "jpeg": Cloudinary files a .jpeg upload as jpg, but accepting the long
// spelling costs nothing.
const MEMORY_ITEM_URL_EXTENSIONS: Record<MediaType, readonly string[]> = {
  IMAGE: [...MEMORY_ITEM_IMAGE_ALLOWED_FORMATS.split(','), 'jpeg'],
  VIDEO: MEMORY_ITEM_VIDEO_ALLOWED_FORMATS.split(','),
};

const assertItemAcceptableOrDestroy = async (
  event: EntitlementDerivableEvent & { id: string },
  mediaType: MediaType,
  bytes: number,
  cloudinaryPublicId: string,
  mediaUrl: string,
  audience: 'organiser' | 'guest' = 'organiser'
): Promise<void> => {
  // The publicId is client-supplied, and both rejection branches below
  // DESTROY it with our API secret; an accepted one is stored and shown.
  // It must be one this server signed for THIS event's Memory Hub folder
  // (upload-folders.ts), or it is a 422 and nothing is destroyed. Before
  // this check, any guest holding an invite token could have the server
  // delete any asset whose publicId they could read off a Cloudinary URL,
  // other events' and other tenants' included.
  if (!isSignedPublicIdInFolder(cloudinaryPublicId, memoryHubFolder(event.tenantId, event.id))) {
    throw new HttpError(
      422,
      audience === 'guest'
        ? "This photo or video wasn't uploaded for this event. Please try uploading it again."
        : "This file wasn't uploaded for this event's Memory Hub. Upload it again from this event."
    );
  }

  const resourceType = mediaType === 'VIDEO' ? 'video' : 'image';

  // mediaUrl is what every gallery viewer actually loads. It must be our
  // delivery URL for exactly the publicId just checked; otherwise a vetted
  // publicId could sit beside a URL pointing anywhere, off Cloudinary
  // included. Also before either destroy below: a mismatched pair is a 422
  // with nothing destroyed, like a foreign publicId.
  if (!isCloudinaryDeliveryUrlFor(mediaUrl, {
    cloudName: requireCloudinaryConfig().cloudName,
    resourceType,
    publicId: cloudinaryPublicId,
    extensions: MEMORY_ITEM_URL_EXTENSIONS[mediaType],
  })) {
    throw new HttpError(
      422,
      audience === 'guest'
        ? "This photo or video's link doesn't match what was uploaded. Please try uploading it again."
        : "This file's link must be the one our uploader returned for it. Upload it again from this event."
    );
  }

  if (isMemoryItemTooLarge(mediaType, bytes)) {
    void destroyAsset(cloudinaryPublicId, resourceType).then((result) => {
      if (!result.ok) console.error('[cloudinary cleanup] failed to delete oversized memory item:', result.reason);
    });
    throw new HttpError(400, memoryItemTooLargeMessage(mediaType, bytes));
  }

  const maxBytes = await getMemoryHubQuotaBytes(event);
  if (maxBytes != null) {
    const usedBytes = await memoryHubRepository.sumBytesForEvent(event.id);
    if (usedBytes + bytes > maxBytes) {
      void destroyAsset(cloudinaryPublicId, resourceType).then((result) => {
        if (!result.ok) console.error('[cloudinary cleanup] failed to delete over-quota memory item:', result.reason);
      });
      // Guest-safe wording (Contract C) — no plan/tier name, no
      // "upgrade". Organiser wording is unchanged.
      throw new HttpError(
        403,
        audience === 'guest'
          ? "This event's photo album is full, so new photos can't be added right now."
          : tierRefusalMessage(
              `This upload would take the event's Memory Hub over its storage limit, so it wasn't saved. Remove items or upgrade the plan.`,
              launchLimitMessage(`This upload wasn't saved, because it would take the event's Memory Hub over its storage limit`, 'Remove items to free up space')
            )
      );
    }
  }
};

// Guest-view projection (invite token holders) — no uploader identity
// beyond a display name, no guest contact details, no tenant/event-internal
// ids (Task 4). The share-link gallery uses toGalleryItem below instead.
const toPublicItem = (item: {
  id: string;
  mediaUrl: string;
  mediaType: MediaType;
  caption: string | null;
  createdAt: Date;
  uploadedByGuest: { firstName: string | null } | null;
  uploadedByUser: { username: string } | null;
}) => ({
  id: item.id,
  mediaUrl: item.mediaUrl,
  mediaType: item.mediaType,
  caption: item.caption,
  createdAt: item.createdAt,
  uploaderDisplayName: item.uploadedByUser?.username ?? item.uploadedByGuest?.firstName ?? 'A guest',
});

// Share-link gallery projection (viewByShareToken) — anyone holding the
// link sees it, so no uploader name at all, guest or organiser, and only
// what the page uses: the photo, its type (the page shows photos only) and
// its caption. Order is the server's (newest first), so no createdAt.
const toGalleryItem = (item: {
  id: string;
  mediaUrl: string;
  mediaType: MediaType;
  caption: string | null;
}) => ({
  id: item.id,
  mediaUrl: item.mediaUrl,
  mediaType: item.mediaType,
  caption: item.caption,
});

// The one answer for a share link that shows nothing: unknown, revoked,
// archived, or on a plan without Memory Hub. Says nothing about who is
// looking, since anyone holding the link can.
export const INACTIVE_SHARE_LINK_MESSAGE = "This link isn't active.";

// Curation projection — same join as toPublicItem above (Guest:
// firstName only, User: username only; never email/phone — a display
// name is all curation needs), reused rather than a second shape.
// Curation additionally needs to tell guest and organiser uploads
// apart, which the public gallery never has to; that's the one thing
// added on top of the shared join. Keyed off the raw FK id rather than
// the resolved relation so "who uploaded this" survives even when the
// relation itself doesn't resolve to anything useful — a guest who
// uploads before ever supplying a name at RSVP (firstName is nullable)
// falls back exactly like toPublicItem's guest branch does; a
// completely unresolvable relation (neither id set) is defensive only,
// not a state normal flows can reach.
const toCuratedItem = <T extends {
  uploadedByGuestId: string | null;
  uploadedByUserId: string | null;
  uploadedByGuest: { firstName: string | null } | null;
  uploadedByUser: { username: string } | null;
}>(item: T) => {
  const { uploadedByGuest, uploadedByUser, ...rest } = item;
  const uploaderType: 'GUEST' | 'ORGANISER' | 'UNKNOWN' = item.uploadedByUserId
    ? 'ORGANISER'
    : item.uploadedByGuestId
      ? 'GUEST'
      : 'UNKNOWN';
  const uploaderDisplayName =
    uploaderType === 'ORGANISER' ? uploadedByUser?.username ?? 'A team member'
    : uploaderType === 'GUEST' ? uploadedByGuest?.firstName ?? 'A guest'
    : 'Unknown uploader';

  return { ...rest, uploaderType, uploaderDisplayName };
};

export const memoryHubService = {

  // ── Memory Hub — MANAGEMENT, strictly tenant-scoped ───────────────
  //
  // Every method gates through eventService.getById() (transitively,
  // via getById below) exactly like event-day/guest/invite — the audit
  // found NONE of these were scoped at all before, make-public worst of
  // all. See the batch report for the full list of what changed.

  // The tier check here (not on getById below) is the "does this
  // organiser's plan even have Memory Hub" entry point — Spark has no
  // Memory Hub at all, and this says so clearly rather than handing
  // back a technically-real-but-useless hub (the row exists regardless,
  // created automatically with every event, so upgrading later needs
  // no backfill — see event.repository.ts's create()). SUPER_ADMIN
  // bypasses, same as every other tier gate in this codebase: support
  // access isn't bound by a tenant's plan.
  getByEventId: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    const event = await eventService.getById(eventId, requestingRole, tenantId); // throws 404 if wrong tenant
    if (requestingRole !== 'SUPER_ADMIN') {
      await assertMemoryHubAccessible(event);
    }
    const hub = await memoryHubRepository.findByEventId(eventId, includeArchived);
    if (!hub) throw new HttpError(404, 'Memory hub not found for this event');
    return hub;
  },

  // Detail-view read only — adds a usage SUM and a tier-config lookup on
  // top of getByEventId, same "getDetail wraps getById" split as
  // event.service.ts's getDetail/getById (see its comment on why:
  // getById there is the ownership gate every other internal call pays,
  // so the extra query goes on a detail-only wrapper instead). getByEventId
  // here has exactly one caller today — the GET /:eventId/memory-hub
  // route below — but the split keeps it that way rather than assuming it
  // always will be.
  //
  // usedBytes/limitBytes reuse the SAME functions assertMemoryHubQuotaAvailable
  // uses to enforce the limit (memoryHubRepository.sumBytesForEvent,
  // getMemoryHubQuotaBytes) — not a re-derivation — so what's reported here
  // can never disagree with what a guest/organiser upload actually gets
  // rejected against. limitBytes is `number | null` and always populated;
  // null unambiguously means unlimited (same convention as every other
  // max* column) — there is no separate "unknown" state to represent.
  getDetailByEventId: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const hub = await memoryHubService.getByEventId(eventId, requestingRole, tenantId);
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    const usedBytes = await memoryHubRepository.sumBytesForEvent(eventId);
    const limitBytes = await getMemoryHubQuotaBytes(event);
    return { ...hub, usedBytes, limitBytes };
  },

  // THE HUB UNDER ITS URL — /api/events/:eventId/memory-hub/:id. The
  // URL's event is gated first (tenant scoping and the assignment lock,
  // eventService.getById), then the hub must be THAT event's: a hub of
  // the same tenant's other event is the same 404 as another tenant's or
  // a missing one (STEERING "A sub-resource must belong to the event in
  // its URL"). It used to gate only on the hub's own event, so any of a
  // tenant's hubs could be edited under any of its events' URLs. The
  // parent event is the default (live-only) lookup: an archived event's
  // hub can't be reached, nor restored before the event is.
  hubInScope: async (eventId: string, hubId: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    const hub = await memoryHubRepository.findById(hubId, includeArchived);
    if (!hub || hub.eventId !== eventId) throw new HttpError(404, 'Memory hub not found');
    return { hub, event };
  },

  // An item under /:hubId/items/:id: in scope only when its hub is the
  // URL's hub, under the URL's event (hubInScope). Item routes used to
  // ignore both and gate on the item's own hub.
  itemInScope: async (
    eventId: string,
    hubId: string,
    itemId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    includeArchived = false
  ) => {
    await memoryHubService.hubInScope(eventId, hubId, requestingRole, tenantId);
    const item = await memoryHubRepository.findItemById(itemId, includeArchived);
    if (!item || item.memoryHubId !== hubId) throw new HttpError(404, 'Memory item not found');
    return item;
  },

  // Every event gets one automatically at creation now (both the wizard's
  // materialize path and the direct POST — see event.repository.ts's
  // create()); this stays as a defensive/repair path, safe to call
  // again (409s if one already exists) rather than something normal
  // flows depend on.
  create: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateMemoryHubDto) => {
    await eventService.getById(eventId, requestingRole, tenantId);
    assertValidOpensAt(data?.opensAt);
    const existing = await memoryHubRepository.findByEventId(eventId);
    if (existing) throw new HttpError(409, 'A memory hub already exists for this event');
    return memoryHubRepository.create(eventId, userId, data);
  },

  update: async (eventId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateMemoryHubDto) => {
    await memoryHubService.hubInScope(eventId, id, requestingRole, tenantId);
    assertValidOpensAt(data?.opensAt);
    return memoryHubRepository.update(id, userId, data);
  },

  archive: async (eventId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await memoryHubService.hubInScope(eventId, id, requestingRole, tenantId);
    return memoryHubRepository.archive(id, userId);
  },

  // Self-service restore (any EVENT_ADMIN+ of the owning tenant, or
  // SUPER_ADMIN) — mirrors Guest/Invite/Vendor Space's precedent
  // (already self-service, transitively tenant-scoped), not Event's
  // (SUPER_ADMIN-only "support" action), since hub management is
  // already self-service at every other step.
  reactivate: async (eventId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // Must look up including archived — the whole point of reactivate is
    // to find a hub that is currently archived and un-archive it. Its
    // parent event via the DEFAULT (non-archived-required) lookup — same
    // precedent as invite.service.ts's reactivate: a child can't be
    // restored while its parent is still archived; restore the event first.
    await memoryHubService.hubInScope(eventId, id, requestingRole, tenantId, true);
    await memoryHubRepository.reactivate(id, userId);
    return (await memoryHubService.hubInScope(eventId, id, requestingRole, tenantId, true)).hub;
  },

  // ── Share link (Task 4) ────────────────────────────────────────────
  //
  // The token itself is 32 random bytes hex (memory-hub.repository.ts's
  // generateShareToken), matching invite token generation exactly —
  // 256 bits, unguessable. Regenerating overwrites the column, so the
  // previous token stops matching anything: it is genuinely invalidated,
  // not just hidden.

  regenerateShareLink: async (eventId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await memoryHubService.hubInScope(eventId, id, requestingRole, tenantId);
    return memoryHubRepository.generateShareToken(id, userId);
  },

  revokeShareLink: async (eventId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await memoryHubService.hubInScope(eventId, id, requestingRole, tenantId);
    return memoryHubRepository.revokeShareToken(id, userId);
  },

  // ── Public gallery (Task 4) — unauthenticated, token only ─────────
  //
  // Returns flags rather than throwing on "not open"/"cancelled", since
  // the caller is a guest's browser rendering a page — same "return
  // flags, don't throw" design as rsvp.service.ts's validate(). Invalid/
  // unknown token is the one genuinely error-throwing case (no hub to
  // shape a flags-response from), same reasoning as RSVP's equivalent.
  //
  // NOTE — isCancelled is a deliberate, prompt-directed exception to
  // STEERING's stated "Memory Hub access is governed solely by opensAt
  // and is independent of event status" domain rule. This batch's
  // prompt explicitly asks to "handle... the event being cancelled" for
  // this endpoint specifically; flagging the conflict rather than
  // silently picking one, per STEERING's own instruction for handling
  // contradictions.
  //
  // A plan without Memory Hub (lapsed, downgraded, pass expired) answers
  // exactly like an unknown token, so the response never tells a link
  // holder anything about the organiser's billing. Videos are left out
  // while `memoryHubVideo` is off.
  viewByShareToken: async (shareToken: string) => {
    const hub = await memoryHubRepository.findByShareToken(shareToken, { includeVideos: isMemoryHubVideoEnabled() });
    if (!hub || !(await isMemoryHubTierEnabled(hub.event))) throw new HttpError(404, INACTIVE_SHARE_LINK_MESSAGE);

    const effectiveStatus = resolveEffectiveStatus(hub.event);
    const isCancelled = effectiveStatus === 'CANCELLED';
    const isOpen = !hub.opensAt || hub.opensAt <= new Date();
    const canView = isOpen && !isCancelled;

    // Exactly what the gallery page uses (the frontend's
    // public-memories-page): the event's name, whether to show photos at
    // all, and the photos. Nothing it doesn't show — no hub title or
    // description, no host name.
    return {
      eventName: hub.event.name,
      isOpen,
      isCancelled,
      items: canView ? hub.memoryItems.map(toGalleryItem) : [],
    };
  },

  // ── Memory Items — organiser/curation side, tenant-scoped ─────────

  getAllItems: async (eventId: string, hubId: string, requestingRole: PlatformRole, tenantId: string | null, status?: 'PENDING' | 'APPROVED' | 'REJECTED') => {
    await memoryHubService.hubInScope(eventId, hubId, requestingRole, tenantId);
    const items = await memoryHubRepository.findAllItems(hubId, status);
    return items.map(toCuratedItem);
  },

  getItemById: async (eventId: string, hubId: string, id: string, requestingRole: PlatformRole, tenantId: string | null) =>
    toCuratedItem(await memoryHubService.itemInScope(eventId, hubId, id, requestingRole, tenantId)),

  // ORGANISER upload persist — items land APPROVED immediately (an
  // organiser reviewing their own upload is pointless friction).
  createOrganiserItem: async (
    eventId: string,
    hubId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: CreateMemoryItemDto
  ) => {
    if (typeof data?.mediaUrl !== 'string' || !data.mediaUrl) {
      throw new HttpError(400, 'mediaUrl is required');
    }
    if (typeof data.cloudinaryPublicId !== 'string' || !data.cloudinaryPublicId) {
      throw new HttpError(400, 'cloudinaryPublicId is required');
    }
    if (data.mediaType !== 'IMAGE' && data.mediaType !== 'VIDEO') {
      throw new HttpError(400, "mediaType ('IMAGE' or 'VIDEO') is required");
    }
    if (typeof data.bytes !== 'number' || !Number.isFinite(data.bytes) || data.bytes <= 0) {
      throw new HttpError(400, 'bytes is required and must be a positive number');
    }

    const { event } = await memoryHubService.hubInScope(eventId, hubId, requestingRole, tenantId);

    await assertItemAcceptableOrDestroy(event, data.mediaType, data.bytes, data.cloudinaryPublicId, data.mediaUrl);

    return memoryHubRepository.createItem(hubId, userId, {
      mediaUrl: data.mediaUrl,
      cloudinaryPublicId: data.cloudinaryPublicId,
      mediaType: data.mediaType,
      bytes: data.bytes,
      ...(data.caption !== undefined && { caption: data.caption }),
      status: 'APPROVED',
      uploadedByUserId: userId,
    });
  },

  updateItem: async (eventId: string, hubId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateMemoryItemDto) => {
    await memoryHubService.itemInScope(eventId, hubId, id, requestingRole, tenantId);
    return memoryHubRepository.updateItemCaption(id, userId, data.caption);
  },

  // ── Curation (Task 3) ──────────────────────────────────────────────
  //
  // Rejecting HIDES the item and excludes it from quota — it does NOT
  // delete the Cloudinary asset. See memoryHubRepository.sumBytesForEvent
  // (status IN (PENDING, APPROVED) only) and the batch report's full
  // reasoning: a full delete is irreversible, contradicting this
  // codebase's "nothing is truly deleted" philosophy; leaving it
  // counting against quota would mean a flood of rejected guest
  // uploads could exhaust an event's storage limit with content the
  // organiser already said no to. The asset stays until an explicit
  // purge — not built in this batch (archiving an item, below, is the
  // only removal action that exists today; a true irreversible delete
  // is future work if storage cost demands it).
  curateItem: async (eventId: string, hubId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, status: 'APPROVED' | 'REJECTED') => {
    await memoryHubService.itemInScope(eventId, hubId, id, requestingRole, tenantId);
    return memoryHubRepository.updateItemStatus(id, userId, status);
  },

  // Archiving ALSO excludes an item from quota (same query, same
  // reasoning as reject) and does NOT touch its Cloudinary asset —
  // consistent with the event cover precedent: archiving is reversible,
  // deleting the asset would break restore.
  archiveItem: async (eventId: string, hubId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await memoryHubService.itemInScope(eventId, hubId, id, requestingRole, tenantId);
    return memoryHubRepository.archiveItem(id, userId);
  },

  reactivateItem: async (eventId: string, hubId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // The item including archived; its hub via the DEFAULT (non-archived-
    // required) lookup — same "restore the parent first" precedent as the
    // hub's own reactivate.
    await memoryHubService.itemInScope(eventId, hubId, id, requestingRole, tenantId, true);
    await memoryHubRepository.reactivateItem(id, userId);
    return memoryHubService.getItemById(eventId, hubId, id, requestingRole, tenantId);
  },

  // ── GUEST upload path — authenticated by invite token only ────────
  //
  // Mirrors rsvp.service.ts exactly: resolve the invite by token, gate
  // on event/hub state, never touch platform auth. The event is
  // resolved through the invite (which is itself the guest's only
  // credential), not through eventService.getById — a guest has no
  // tenantId/role to scope with in the first place.

  requestGuestUploadSignature: async (token: unknown, mediaType: unknown) => {
    // Both arrive straight from an unauthenticated request body — a
    // missing/non-string token would otherwise reach
    // inviteRepository.findByToken as `undefined` and raise a raw
    // Prisma validation error (a 500, and in dev a full schema dump to
    // an anonymous caller) instead of a clean rejection. Validate the
    // shape before it ever reaches Prisma.
    if (typeof token !== 'string' || !token) {
      throw new HttpError(400, 'token is required');
    }
    if (mediaType !== 'IMAGE' && mediaType !== 'VIDEO') {
      throw new HttpError(400, "mediaType ('IMAGE' or 'VIDEO') is required");
    }

    const invite = await inviteRepository.findByToken(token);
    if (!invite) {
      throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }

    if (resolveEffectiveStatus(invite.event) === 'CANCELLED') {
      throw new HttpError(403, 'This event has been cancelled.');
    }

    const hub = await memoryHubRepository.findByEventId(invite.eventId);
    // Guest-safe wording (Contract C) — "photo album", never "Memory Hub".
    if (!hub) throw new HttpError(404, "This event doesn't have a photo album yet.");

    if (hub.opensAt && hub.opensAt > new Date()) {
      throw new HttpError(403, `This event's photo album opens on ${formatGuestDate(hub.opensAt)}. Check back then to add your photos and videos.`);
    }

    assertMemoryItemMediaTypeAvailable(mediaType, 'guest');
    await assertMemoryHubAccessible(invite.event, 'guest');
    await assertMemoryHubQuotaAvailable(invite.event, 'guest');

    return signMemoryItemUpload(invite.event.tenantId, invite.eventId, mediaType);
  },

  // ── GUEST availability + view (Contract B) — authenticated by invite
  // token only, never platform auth. Same "return flags, don't throw"
  // design as getProgramForInvite/validate(): answers "does this event
  // even have a Memory Hub a guest can see" for the page's tab decision,
  // with NO upload signature required just to render (unlike
  // requestGuestUploadSignature above, which is a grant and stays
  // rate-limited/quota-checked separately). Invalid/unknown token is the
  // one genuinely error-throwing case, same as every other guest path.
  getGuestView: async (token: unknown) => {
    if (typeof token !== 'string' || !token) {
      throw new HttpError(400, 'token is required');
    }

    const invite = await inviteRepository.findByToken(token);
    if (!invite) {
      throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }

    if (resolveEffectiveStatus(invite.event) === 'CANCELLED') {
      return { available: false as const };
    }

    // findByEventId defaults to includeArchived: false, so an archived
    // hub folds into "no hub" here — same bucket, same response.
    const hub = await memoryHubRepository.findByEventId(invite.eventId);
    if (!hub) {
      return { available: false as const };
    }

    if (hub.opensAt && hub.opensAt > new Date()) {
      return { available: false as const };
    }

    if (!(await isMemoryHubTierEnabled(invite.event))) {
      return { available: false as const };
    }

    const [approvedItems, pendingItems] = await Promise.all([
      memoryHubRepository.findAllItems(hub.id, 'APPROVED'),
      memoryHubRepository.findPendingItemsByGuest(hub.id, invite.guestId),
    ]);

    // The guest's own photos (pending and approved) and whether each may be
    // shared publicly, with the wording they agree to. Left out entirely
    // while `feedback` is off, like a switched-off feature's settings.
    let publicSharing: {
      wording: { version: number; text: string };
      myItems: { id: string; allowPublicSharing: boolean }[];
    } | undefined;
    if (isFeatureEnabled('feedback')) {
      const mine = await memoryHubRepository.findShareablePhotosByGuest(hub.id, invite.guestId);
      const sharing = await consentService.guestSharingFor(mine.map((item) => item.id));
      publicSharing = {
        wording: currentConsentWording('PHOTO_GUEST_PUBLIC_SHARING'),
        myItems: mine.map((item) => ({ id: item.id, allowPublicSharing: sharing.get(item.id) === true })),
      };
    }

    return {
      available: true as const,
      title: hub.title,
      description: hub.description,
      // Static — every guest upload lands PENDING regardless of hub/tier
      // (see createGuestItem below); there is no per-hub/per-tier toggle
      // to read this from.
      requiresApproval: true as const,
      items: approvedItems.map(toPublicItem),
      myPendingItems: pendingItems.map((item) => ({
        id: item.id,
        mediaUrl: item.mediaUrl,
        mediaType: item.mediaType,
        caption: item.caption,
        createdAt: item.createdAt,
      })),
      limits: {
        imageMaxBytes: MEMORY_ITEM_IMAGE_MAX_BYTES,
        // With `memoryHubVideo` off a video upload signature is refused, so
        // videos aren't offered: no video size, and formats are images only.
        videosAllowed: isMemoryHubVideoEnabled(),
        videoMaxBytes: isMemoryHubVideoEnabled() ? MEMORY_ITEM_VIDEO_MAX_BYTES : null,
        allowedFormats: memoryItemAllowedFormats(),
        // The real per-invite upload budget (memoryHubGuestUploadLimiter,
        // rate-limit.middleware.ts) — reported here so the frontend reads
        // the actual enforced number instead of hardcoding its own copy.
        uploadRequestsPer5Min: MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN,
      },
      ...(publicSharing ? { publicSharing } : {}),
    };
  },

  // GUEST upload persist — items land PENDING (require organiser
  // approval): a guest uploading something inappropriate to a wedding
  // gallery is the exact scenario curation exists to prevent.
  createGuestItem: async (data: CreateGuestMemoryItemDto) => {
    // Same reasoning as requestGuestUploadSignature above — this arrives
    // straight from an unauthenticated body; a missing/malformed field
    // must not reach Prisma as a raw type error.
    if (typeof data?.token !== 'string' || !data.token) {
      throw new HttpError(400, 'token is required');
    }
    if (typeof data.mediaUrl !== 'string' || !data.mediaUrl) {
      throw new HttpError(400, 'mediaUrl is required');
    }
    if (typeof data.cloudinaryPublicId !== 'string' || !data.cloudinaryPublicId) {
      throw new HttpError(400, 'cloudinaryPublicId is required');
    }
    if (data.mediaType !== 'IMAGE' && data.mediaType !== 'VIDEO') {
      throw new HttpError(400, "mediaType ('IMAGE' or 'VIDEO') is required");
    }
    if (typeof data.bytes !== 'number' || !Number.isFinite(data.bytes) || data.bytes <= 0) {
      throw new HttpError(400, 'bytes is required and must be a positive number');
    }
    if (data.allowPublicSharing !== undefined && typeof data.allowPublicSharing !== 'boolean') {
      throw new HttpError(400, 'allowPublicSharing must be true or false');
    }
    // Off by default: only an explicit true is an opt-in. With `feedback`
    // off the opt-in isn't offered, so nothing is recorded.
    const allowPublicSharing = data.allowPublicSharing === true && isFeatureEnabled('feedback');

    const invite = await inviteRepository.findByToken(data.token);
    if (!invite) {
      throw new HttpError(404, INVALID_INVITE_MESSAGE);
    }

    if (resolveEffectiveStatus(invite.event) === 'CANCELLED') {
      throw new HttpError(403, 'This event has been cancelled.');
    }

    const hub = await memoryHubRepository.findByEventId(invite.eventId);
    // Guest-safe wording (Contract C) — "photo album", never "Memory Hub".
    if (!hub) throw new HttpError(404, "This event doesn't have a photo album yet.");

    if (hub.opensAt && hub.opensAt > new Date()) {
      throw new HttpError(403, `This event's photo album opens on ${formatGuestDate(hub.opensAt)}. Check back then to add your photos and videos.`);
    }

    // Before the checks below, some of which destroy the upload: a refused
    // opt-in leaves the file for the guest to save again without it.
    if (allowPublicSharing) assertSharingIsForAPhoto(data.mediaType);

    await assertItemAcceptableOrDestroy(invite.event, data.mediaType, data.bytes, data.cloudinaryPublicId, data.mediaUrl, 'guest');

    const item = await memoryHubRepository.withTransaction(async (tx) => {
      const created = await memoryHubRepository.createItem(hub.id, GUEST_ACTOR, {
        mediaUrl: data.mediaUrl,
        cloudinaryPublicId: data.cloudinaryPublicId,
        mediaType: data.mediaType,
        bytes: data.bytes,
        ...(data.caption !== undefined && { caption: data.caption }),
        status: 'PENDING',
        uploadedByGuestId: invite.guestId,
      }, tx);
      if (allowPublicSharing) {
        await consentService.record([{
          eventId: invite.eventId,
          kind: 'PHOTO_GUEST_PUBLIC_SHARING',
          memoryItemId: created.id,
          userId: null,
          guestId: invite.guestId,
          action: 'GRANTED',
        }], tx);
      }
      return created;
    });

    // Explicit shape, not the raw MemoryItem row — no memoryHubId,
    // cloudinaryPublicId, uploadedByGuestId, isArchived, createdBy/
    // updatedBy. Enough for the guest's browser to confirm the upload
    // and show it awaiting approval, same allowlist spirit as
    // toPublicItem/toCuratedItem above.
    return {
      id: item.id,
      mediaUrl: item.mediaUrl,
      mediaType: item.mediaType,
      caption: item.caption,
      status: item.status,
      ...(isFeatureEnabled('feedback') ? { allowPublicSharing } : {}),
    };
  },

  // GUEST public-sharing toggle (the `feedback` flag) — authenticated by
  // invite token only, like guest-view. A guest changes their mind about
  // one of their OWN photos: anyone else's, or one that isn't live, is the
  // same 404. Allowed whatever the event's or album's state, so a guest
  // can always withdraw. Only a change is recorded: setting what is
  // already current appends nothing.
  setGuestPublicSharing: async (token: unknown, itemId: unknown, allowPublicSharing: unknown) => {
    if (typeof token !== 'string' || !token) {
      throw new HttpError(400, 'token is required');
    }
    if (typeof itemId !== 'string' || !itemId) {
      throw new HttpError(400, 'itemId is required');
    }
    if (typeof allowPublicSharing !== 'boolean') {
      throw new HttpError(400, 'allowPublicSharing must be true or false');
    }

    const invite = await inviteRepository.findByToken(token);
    if (!invite) {
      throw new HttpError(404, INVALID_INVITE_MESSAGE);
    }

    const item = await memoryHubRepository.findGuestItem(itemId, invite.eventId, invite.guestId);
    if (!item) throw new HttpError(404, "We couldn't find that photo.");
    if (allowPublicSharing) assertSharingIsForAPhoto(item.mediaType);

    const current = (await consentService.guestSharingFor([item.id])).get(item.id) === true;
    if (current !== allowPublicSharing) {
      await consentService.record([{
        eventId: invite.eventId,
        kind: 'PHOTO_GUEST_PUBLIC_SHARING',
        memoryItemId: item.id,
        userId: null,
        guestId: invite.guestId,
        action: allowPublicSharing ? 'GRANTED' : 'WITHDRAWN',
      }]);
    }

    return { id: item.id, allowPublicSharing };
  },
};
