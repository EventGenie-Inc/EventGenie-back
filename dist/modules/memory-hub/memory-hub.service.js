import {} from '@prisma/client';
import { memoryHubRepository } from './memory-hub.repository.js';
import {} from './memory-hub.types.js';
import { eventService } from '../event/event.service.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { destroyAsset } from '../../shared/cloudinary/cloudinary.client.js';
import { signMemoryItemUpload } from '../upload/upload.service.js';
import { assertMemoryHubAccessible, assertMemoryHubQuotaAvailable, getMemoryHubQuotaBytes } from './memory-hub-tier-enforcement.util.js';
import { isMemoryItemTooLarge, memoryItemTooLargeMessage } from './memory-item-limits.util.js';
// Guest-originated writes have no platform userId — Invite.updatedBy is
// a plain String (not an FK), same convention as rsvp.service.ts's
// GUEST_ACTOR.
const GUEST_ACTOR = 'guest-memory-upload';
// Checked at PERSIST time (after Cloudinary has already reported the
// real byte count) — the pre-signature checks in
// memory-hub-tier-enforcement.util.ts can only catch "already full
// before this upload started"; the exact size of THIS file is
// unknowable until now. An oversized or over-quota upload is destroyed
// from Cloudinary immediately rather than left as an orphan nobody
// ever references — same reasoning as event-cover-image.util.ts.
const assertItemAcceptableOrDestroy = async (eventId, tenantId, mediaType, bytes, cloudinaryPublicId) => {
    const resourceType = mediaType === 'VIDEO' ? 'video' : 'image';
    if (isMemoryItemTooLarge(mediaType, bytes)) {
        void destroyAsset(cloudinaryPublicId, resourceType).then((result) => {
            if (!result.ok)
                console.error('[cloudinary cleanup] failed to delete oversized memory item:', result.reason);
        });
        throw new HttpError(400, memoryItemTooLargeMessage(mediaType, bytes));
    }
    const maxBytes = await getMemoryHubQuotaBytes(tenantId);
    if (maxBytes != null) {
        const usedBytes = await memoryHubRepository.sumBytesForEvent(eventId);
        if (usedBytes + bytes > maxBytes) {
            void destroyAsset(cloudinaryPublicId, resourceType).then((result) => {
                if (!result.ok)
                    console.error('[cloudinary cleanup] failed to delete over-quota memory item:', result.reason);
            });
            throw new HttpError(403, `This upload would push the event's Memory Hub over its storage limit. It has not been saved — remove existing items or upgrade the plan.`);
        }
    }
};
// Public projection — no uploader identity beyond a display name, no
// guest contact details, no tenant/event-internal ids (Task 4).
const toPublicItem = (item) => ({
    id: item.id,
    mediaUrl: item.mediaUrl,
    mediaType: item.mediaType,
    caption: item.caption,
    createdAt: item.createdAt,
    uploaderDisplayName: item.uploadedByUser?.username ?? item.uploadedByGuest?.firstName ?? 'A guest',
});
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
const toCuratedItem = (item) => {
    const { uploadedByGuest, uploadedByUser, ...rest } = item;
    const uploaderType = item.uploadedByUserId
        ? 'ORGANISER'
        : item.uploadedByGuestId
            ? 'GUEST'
            : 'UNKNOWN';
    const uploaderDisplayName = uploaderType === 'ORGANISER' ? uploadedByUser?.username ?? 'A team member'
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
    getByEventId: async (eventId, requestingRole, tenantId, includeArchived = false) => {
        const event = await eventService.getById(eventId, requestingRole, tenantId); // throws 404 if wrong tenant
        if (requestingRole !== 'SUPER_ADMIN') {
            await assertMemoryHubAccessible(event.tenantId);
        }
        const hub = await memoryHubRepository.findByEventId(eventId, includeArchived);
        if (!hub)
            throw new HttpError(404, 'Memory hub not found for this event');
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
    getDetailByEventId: async (eventId, requestingRole, tenantId) => {
        const hub = await memoryHubService.getByEventId(eventId, requestingRole, tenantId);
        const event = await eventService.getById(eventId, requestingRole, tenantId);
        const usedBytes = await memoryHubRepository.sumBytesForEvent(eventId);
        const limitBytes = await getMemoryHubQuotaBytes(event.tenantId);
        return { ...hub, usedBytes, limitBytes };
    },
    getById: async (id, requestingRole, tenantId, includeArchived = false) => {
        const hub = await memoryHubRepository.findById(id, includeArchived);
        if (!hub)
            throw new HttpError(404, 'Memory hub not found');
        // Ownership gate via the parent event — throws 404 if it belongs to
        // a different tenant, indistinguishable from the hub not existing.
        await eventService.getById(hub.eventId, requestingRole, tenantId);
        return hub;
    },
    // Every event gets one automatically at creation now (both the wizard's
    // materialize path and the direct POST — see event.repository.ts's
    // create()); this stays as a defensive/repair path, safe to call
    // again (409s if one already exists) rather than something normal
    // flows depend on.
    create: async (eventId, userId, requestingRole, tenantId, data) => {
        await eventService.getById(eventId, requestingRole, tenantId);
        const existing = await memoryHubRepository.findByEventId(eventId);
        if (existing)
            throw new HttpError(409, 'A memory hub already exists for this event');
        return memoryHubRepository.create(eventId, userId, data);
    },
    update: async (id, userId, requestingRole, tenantId, data) => {
        await memoryHubService.getById(id, requestingRole, tenantId);
        return memoryHubRepository.update(id, userId, data);
    },
    archive: async (id, userId, requestingRole, tenantId) => {
        await memoryHubService.getById(id, requestingRole, tenantId);
        return memoryHubRepository.archive(id, userId);
    },
    // Self-service restore (any EVENT_ADMIN+ of the owning tenant, or
    // SUPER_ADMIN) — mirrors Guest/Invite/Vendor Space's precedent
    // (already self-service, transitively tenant-scoped), not Event's
    // (SUPER_ADMIN-only "support" action), since hub management is
    // already self-service at every other step.
    reactivate: async (id, userId, requestingRole, tenantId) => {
        // Must look up including archived — the whole point of reactivate is
        // to find a hub that is currently archived and un-archive it.
        const hub = await memoryHubRepository.findById(id, true);
        if (!hub)
            throw new HttpError(404, 'Memory hub not found');
        // Parent event via the DEFAULT (non-archived-required) lookup — same
        // precedent as invite.service.ts's reactivate: a child can't be
        // restored while its parent is still archived; restore the event first.
        await eventService.getById(hub.eventId, requestingRole, tenantId);
        await memoryHubRepository.reactivate(id, userId);
        return memoryHubService.getById(id, requestingRole, tenantId, true);
    },
    // ── Share link (Task 4) ────────────────────────────────────────────
    //
    // The token itself is 32 random bytes hex (memory-hub.repository.ts's
    // generateShareToken), matching invite token generation exactly —
    // 256 bits, unguessable. Regenerating overwrites the column, so the
    // previous token stops matching anything: it is genuinely invalidated,
    // not just hidden.
    regenerateShareLink: async (id, userId, requestingRole, tenantId) => {
        await memoryHubService.getById(id, requestingRole, tenantId);
        return memoryHubRepository.generateShareToken(id, userId);
    },
    revokeShareLink: async (id, userId, requestingRole, tenantId) => {
        await memoryHubService.getById(id, requestingRole, tenantId);
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
    viewByShareToken: async (shareToken) => {
        const hub = await memoryHubRepository.findByShareToken(shareToken);
        if (!hub)
            throw new HttpError(404, "This gallery link isn't valid. Check the link, or ask the organiser for a new one.");
        const effectiveStatus = resolveEffectiveStatus(hub.event);
        const isCancelled = effectiveStatus === 'CANCELLED';
        const isOpen = !hub.opensAt || hub.opensAt <= new Date();
        const canView = isOpen && !isCancelled;
        return {
            title: hub.title,
            description: hub.description,
            eventName: hub.event.name,
            isOpen,
            isCancelled,
            items: canView ? hub.memoryItems.map(toPublicItem) : [],
        };
    },
    // ── Memory Items — organiser/curation side, tenant-scoped ─────────
    getAllItems: async (hubId, requestingRole, tenantId, status) => {
        await memoryHubService.getById(hubId, requestingRole, tenantId); // throws 404 if wrong tenant
        const items = await memoryHubRepository.findAllItems(hubId, status);
        return items.map(toCuratedItem);
    },
    getItemById: async (id, requestingRole, tenantId) => {
        const item = await memoryHubRepository.findItemById(id);
        if (!item)
            throw new HttpError(404, 'Memory item not found');
        await memoryHubService.getById(item.memoryHubId, requestingRole, tenantId);
        return toCuratedItem(item);
    },
    // ORGANISER upload persist — items land APPROVED immediately (an
    // organiser reviewing their own upload is pointless friction).
    createOrganiserItem: async (hubId, userId, requestingRole, tenantId, data) => {
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
        const hub = await memoryHubService.getById(hubId, requestingRole, tenantId);
        const event = await eventService.getById(hub.eventId, requestingRole, tenantId);
        await assertItemAcceptableOrDestroy(hub.eventId, event.tenantId, data.mediaType, data.bytes, data.cloudinaryPublicId);
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
    updateItem: async (id, userId, requestingRole, tenantId, data) => {
        await memoryHubService.getItemById(id, requestingRole, tenantId);
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
    curateItem: async (id, userId, requestingRole, tenantId, status) => {
        await memoryHubService.getItemById(id, requestingRole, tenantId);
        return memoryHubRepository.updateItemStatus(id, userId, status);
    },
    // Archiving ALSO excludes an item from quota (same query, same
    // reasoning as reject) and does NOT touch its Cloudinary asset —
    // consistent with the event cover precedent: archiving is reversible,
    // deleting the asset would break restore.
    archiveItem: async (id, userId, requestingRole, tenantId) => {
        await memoryHubService.getItemById(id, requestingRole, tenantId);
        return memoryHubRepository.archiveItem(id, userId);
    },
    reactivateItem: async (id, userId, requestingRole, tenantId) => {
        const item = await memoryHubRepository.findItemById(id, true);
        if (!item)
            throw new HttpError(404, 'Memory item not found');
        // Parent hub via the DEFAULT (non-archived-required) lookup — same
        // "restore the parent first" precedent as the hub's own reactivate.
        await memoryHubService.getById(item.memoryHubId, requestingRole, tenantId);
        await memoryHubRepository.reactivateItem(id, userId);
        return memoryHubService.getItemById(id, requestingRole, tenantId);
    },
    // ── GUEST upload path — authenticated by invite token only ────────
    //
    // Mirrors rsvp.service.ts exactly: resolve the invite by token, gate
    // on event/hub state, never touch platform auth. The event is
    // resolved through the invite (which is itself the guest's only
    // credential), not through eventService.getById — a guest has no
    // tenantId/role to scope with in the first place.
    requestGuestUploadSignature: async (token, mediaType) => {
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
        if (!hub)
            throw new HttpError(404, 'This event does not have a Memory Hub yet.');
        if (hub.opensAt && hub.opensAt > new Date()) {
            throw new HttpError(403, `The Memory Hub for this event opens on ${formatGuestDate(hub.opensAt)}. Check back then to add your photos and videos.`);
        }
        await assertMemoryHubAccessible(invite.event.tenantId);
        await assertMemoryHubQuotaAvailable(invite.eventId, invite.event.tenantId);
        return signMemoryItemUpload(invite.event.tenantId, invite.eventId, mediaType);
    },
    // GUEST upload persist — items land PENDING (require organiser
    // approval): a guest uploading something inappropriate to a wedding
    // gallery is the exact scenario curation exists to prevent.
    createGuestItem: async (data) => {
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
        const invite = await inviteRepository.findByToken(data.token);
        if (!invite) {
            throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
        }
        if (resolveEffectiveStatus(invite.event) === 'CANCELLED') {
            throw new HttpError(403, 'This event has been cancelled.');
        }
        const hub = await memoryHubRepository.findByEventId(invite.eventId);
        if (!hub)
            throw new HttpError(404, 'This event does not have a Memory Hub yet.');
        if (hub.opensAt && hub.opensAt > new Date()) {
            throw new HttpError(403, `The Memory Hub for this event opens on ${formatGuestDate(hub.opensAt)}. Check back then to add your photos and videos.`);
        }
        await assertItemAcceptableOrDestroy(invite.eventId, invite.event.tenantId, data.mediaType, data.bytes, data.cloudinaryPublicId);
        return memoryHubRepository.createItem(hub.id, GUEST_ACTOR, {
            mediaUrl: data.mediaUrl,
            cloudinaryPublicId: data.cloudinaryPublicId,
            mediaType: data.mediaType,
            bytes: data.bytes,
            ...(data.caption !== undefined && { caption: data.caption }),
            status: 'PENDING',
            uploadedByGuestId: invite.guestId,
        });
    },
};
//# sourceMappingURL=memory-hub.service.js.map