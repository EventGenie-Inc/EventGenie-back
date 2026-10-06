import { eventRepository } from './event.repository.js';
import { type CreateEventDto, type UpdateEventDto } from './event.types.js';
import { type PlatformRole, type EventStatus } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertEventCreatable, assertEventUpdatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { assertTenantReadyToSellTickets, assertEventReadyToSellTickets } from '../payment-account/payment-account-readiness.util.js';
import { withEffectiveStatus, assertEventIsPublished } from './event-status.util.js';
import { assertValidRsvpDeadline } from './event-rsvp-deadline.util.js';
import { assertValidCapacity } from './event-capacity.util.js';
import { assertValidHostName } from './event-host-name.util.js';
import { isCoverImageTooLarge, coverImageTooLargeMessage, assertCoverPublicIdOwned } from './event-cover-image.util.js';
import { destroyAsset } from '../../shared/cloudinary/cloudinary.client.js';
import { resolveGuestLimit } from '../subscription-tier-config/guest-tier-enforcement.util.js';
import { guestRepository } from '../guest/guest.repository.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
import { resolveTenantScope, isTenantScopeEmptyForList } from '../../shared/utils/tenant-scope.util.js';
import { assertPaidTicketingAvailable } from '../ticket/ticketing-availability.util.js';
import { assertPublicEventsAvailable } from './public-events-availability.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

// Shared by create() and update() — rejects an oversized cover upload
// AND cleans up the now-orphaned asset that's already sitting in
// Cloudinary (it finished uploading before this backend ever learned
// its size — see event-cover-image.util.ts for why the check can only
// happen here, after the fact). Best-effort: a failed delete just means
// a harmless orphan, not a reason to also fail this request differently
// than the size rejection already does.
const assertCoverImageWithinSizeLimit = (data: { coverImageBytes?: number; coverImagePublicId?: string | null }): void => {
  if (!isCoverImageTooLarge(data.coverImageBytes)) return;

  if (data.coverImagePublicId) {
    void destroyAsset(data.coverImagePublicId).then((result) => {
      if (!result.ok) console.error('[cloudinary cleanup] failed to delete oversized upload:', result.reason);
    });
  }

  throw new HttpError(400, coverImageTooLargeMessage(data.coverImageBytes));
};

// WHO may look up an event, decided once for getById and the lean lookups
// below: SUPER_ADMIN is unscoped (that is the role's purpose); everyone else
// is scoped to their own tenant. A non-SUPER_ADMIN with no tenantId now
// fails CLOSED (resolveTenantScope throws 404) instead of falling through
// to an unscoped lookup — see tenant-scope.util.ts for why. Security sweep
// before G3: this used to convert null to undefined and silently widen the
// query to every tenant; not reachable through the ordinary self-service
// signup/create paths, but reachable the moment a SUPER_ADMIN creates an
// EVENT_ADMIN or TENANT_ADMIN without a tenantId (POST /api/users lets a
// SUPER_ADMIN omit it), and that role sits behind requireEventAdmin on
// nearly every organiser route.
// The one required organiser field on the event row itself (the venue is
// per day now, event-day-venue.util.ts). 422 with a message an organiser
// can act on — previously a missing name reached Prisma and came back as a
// generic 500, and a blank one was saved.
const assertEventName = (name: unknown): void => {
  if (typeof name !== 'string' || !name.trim()) {
    throw new HttpError(422, 'Your event needs a name.');
  }
};

const tenantScopeFor = (requestingRole: PlatformRole, tenantId: string | null): string | undefined =>
  resolveTenantScope(requestingRole, tenantId, 'Event not found');

export const eventService = {

  // Both list and detail flow through the SAME withEffectiveStatus
  // presenter, so they can never disagree about a given event's
  // status — there is no separate code path either could drift from.
  getAll: async (requestingRole: PlatformRole, tenantId: string | null) => {
    if (isTenantScopeEmptyForList(requestingRole, tenantId)) return [];
    const events = requestingRole === 'SUPER_ADMIN'
      ? await eventRepository.findAll()
      : await eventRepository.findAll(tenantId ?? undefined);
    return events.map(withEffectiveStatus);
  },

  // includeArchived is only ever true for the SUPER_ADMIN restore flow
  // (reactivate below, and tenantService.getEvents) — every other call
  // site relies on the default so an archived event stays a 404 for
  // everyone else, cross-tenant-access included.
  //
  // THE FULL EVENT — eight queries (the event plus seven relations). Use it
  // only where the relations are actually read or returned: guest export
  // (rsvpFields), the write endpoints that return the event in their
  // response (update/publish/cancel/reactivate), and getDetail. Every other
  // caller wants getScoped or getScopedWithPass below.
  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    const event = await eventRepository.findById(id, includeArchived, tenantScopeFor(requestingRole, tenantId));

    if (!event) throw new HttpError(404, 'Event not found');
    return withEffectiveStatus(event);
  },

  // THE LEAN OWNERSHIP GATE — the event row plus its live days, two queries
  // instead of getById's eight. Refuses exactly what getById refuses (same
  // scope helper, same repository filter): another tenant's event, an
  // archived event and a missing one are all the same 404, and `status` is
  // the EFFECTIVE status (a finished event reads COMPLETED) because eventDays
  // — everything resolveEffectiveStatus needs — are loaded.
  //
  // The return type has NO eventPass, tickets, rsvpFields, program or
  // memoryHub, so a caller that reads one fails to compile rather than
  // silently getting undefined: moving a caller here is checked by tsc.
  // A caller that needs the Event Pass (any tier/entitlement check) uses
  // getScopedWithPass; one that needs the other relations, or returns the
  // event to a client, stays on getById.
  getScoped: async (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    const event = await eventRepository.findScoped(id, includeArchived, tenantScopeFor(requestingRole, tenantId));

    if (!event) throw new HttpError(404, 'Event not found');
    return withEffectiveStatus(event);
  },

  // getScoped plus the Event Pass — three queries. What every tier check
  // needs (EntitlementDerivableEvent = tenantId + eventPass + eventDays).
  getScopedWithPass: async (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    const event = await eventRepository.findScopedWithPass(id, includeArchived, tenantScopeFor(requestingRole, tenantId));

    if (!event) throw new HttpError(404, 'Event not found');
    return withEffectiveStatus(event);
  },

  // Detail-view read only — adds extra queries on top of getById, so
  // this is deliberately NOT what every internal ownership-gate call
  // (guest/event-day/invite/attendance services all call plain getById)
  // pays on every request; only the actual GET /:id route uses this.
  //
  // guestLimit reuses resolveGuestLimit — the same resolution
  // assertGuestsCreatable enforces at write time — so this can never
  // tell an organiser they have room only for the write to then be
  // refused. currentCount is guestRepository.countForEvent, the exact
  // denominator that check compares against (organiser-added guests,
  // excluding plus-ones), not acceptedGuestCount above, which counts a
  // different thing (accepted invites, plus-ones included).
  getDetail: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = await eventService.getById(id, requestingRole, tenantId);
    const acceptedGuestCount = await eventRepository.countAcceptedInvitesForEvent(id);
    const guestLimitInfo = await resolveGuestLimit(event);
    const currentGuestCount = await guestRepository.countForEvent(id);
    return {
      ...event,
      acceptedGuestCount,
      guestLimit: {
        limit: guestLimitInfo.limit, // null = unlimited; the object itself is always present
        currentCount: currentGuestCount,
        source: guestLimitInfo.boundByPass ? 'PASS' : 'PLAN',
        tenantTier: guestLimitInfo.tenantTier,
        passTier: guestLimitInfo.passTier,
        passActive: guestLimitInfo.passActive,
      },
    };
  },

  create: async (tenantId: string, userId: string, data: CreateEventDto) => {
    assertEventName(data.name);
    assertValidCapacity(data.capacity);
    assertValidHostName(data.hostName);
    // Ownership first: the size check below destroys the asset on rejection.
    assertCoverPublicIdOwned(tenantId, data.coverImagePublicId);
    assertCoverImageWithinSizeLimit(data);
    // No event days exist yet on this path (direct POST never creates
    // them — see event-day.router.ts), so there's nothing to compare the
    // deadline against beyond "not in the past".
    assertValidRsvpDeadline(data.rsvpDeadline ? parseClientDateTime(data.rsvpDeadline) : null, [], { rejectPast: true });
    assertPaidTicketingAvailable(data.ticketing);
    assertPublicEventsAvailable(data.visibility);
    await assertEventCreatable(tenantId, {
      ...(data.visibility !== undefined && { visibility: data.visibility }),
      ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
    });
    // A paid event needs somewhere for a ticket split to land — see
    // payment-account-readiness.util.ts's own comment.
    if (data.ticketing === 'PAID') {
      await assertTenantReadyToSellTickets(tenantId);
    }
    return eventRepository.create(tenantId, userId, data);
  },

  update: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDto) => {
    if (data.name !== undefined) assertEventName(data.name);
    assertValidCapacity(data.capacity);
    assertValidHostName(data.hostName);
    // Tier rules are evaluated against the EVENT's owning tenant, not the
    // requester's — a SUPER_ADMIN editing a SPARK tenant's event must still
    // be bound by that tenant's plan, and a SUPER_ADMIN has no tenantId of
    // their own to fall back on.
    const event = await eventService.getById(id, requestingRole, tenantId);

    // Cover ownership is checked against the EVENT's tenant (right for a
    // SUPER_ADMIN too), so it needs the event first; and it must run before
    // the size check, which destroys the asset on rejection. The id already
    // stored on this event is not re-checked (see assertCoverPublicIdOwned).
    if (data.coverImagePublicId !== event.coverImagePublicId) {
      assertCoverPublicIdOwned(event.tenantId, data.coverImagePublicId);
    }
    assertCoverImageWithinSizeLimit(data);

    if (data.rsvpDeadline !== undefined) {
      // rejectPast: false — an organiser deliberately closing RSVPs early
      // by setting the deadline to "now" on a live event is legitimate;
      // only a past deadline at CREATION time is rejected (see create()).
      assertValidRsvpDeadline(data.rsvpDeadline ? parseClientDateTime(data.rsvpDeadline) : null, event.eventDays, { rejectPast: false });
    }

    // Only a CHANGE to paid/public is refused while the feature is off.
    // Past that point, a switched-off feature's value can only be the one
    // already stored, so it stays out of the tier and payout checks below:
    // re-saving an older paid event must not 403 on a plan or ask for bank
    // details, whose routes are off too.
    assertPaidTicketingAvailable(data.ticketing, event.ticketing);
    assertPublicEventsAvailable(data.visibility, event.visibility);
    const ticketing = isFeatureEnabled('ticketing') ? data.ticketing : undefined;
    const visibility = isFeatureEnabled('publicEvents') ? data.visibility : undefined;
    await assertEventUpdatable(event, {
      ...(visibility !== undefined && { visibility }),
      ...(ticketing !== undefined && { ticketing }),
    });
    if (ticketing === 'PAID') {
      await assertEventReadyToSellTickets(event);
    }
    await eventRepository.update(id, userId, data);

    // Cover REPLACED (including cleared to null) — delete the now-orphaned
    // old asset. Fire-and-forget: never let a Cloudinary hiccup fail an
    // otherwise-successful event update; a failed delete is just a
    // harmless orphan (Batch B Task 3), not a broken event. Does NOT run
    // on archive — archiving is reversible, and deleting the cover here
    // would break restore (see the batch report).
    if (
      data.coverImagePublicId !== undefined &&
      event.coverImagePublicId &&
      event.coverImagePublicId !== data.coverImagePublicId
    ) {
      const oldPublicId = event.coverImagePublicId;
      void destroyAsset(oldPublicId).then((result) => {
        if (!result.ok) console.error('[cloudinary cleanup] failed to delete replaced cover:', result.reason);
      });
    }

    // Re-fetched through getById (not the bare update() result) so this
    // response goes through the same withEffectiveStatus presenter as
    // every other read — PUT's response must agree with a subsequent
    // GET, not show raw status while GET shows derived.
    return eventService.getById(id, requestingRole, tenantId);
  },

  archive: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getById(id, requestingRole, tenantId);
    return eventRepository.archive(id, userId);
  },

  // ─────────────────────────────────────────
  //  REACTIVATE — SUPER_ADMIN support action only (event.router.ts gates
  //  this route with requireSuperAdmin). Restores an archived event with
  //  no cascade to its EventDays/Guests/Invites — see the batch report
  //  for why archiving an event doesn't cascade to them in the first
  //  place, which is what makes "just flip isArchived back" sufficient
  //  here.
  // ─────────────────────────────────────────
  reactivate: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // Must look up including archived — the whole point of reactivate is
    // to find an event that is currently archived and un-archive it.
    await eventService.getById(id, requestingRole, tenantId, true);
    await eventRepository.reactivate(id, userId);
    return eventService.getById(id, requestingRole, tenantId, true);
  },

  // PUBLIC-only: the organiser copies this link and distributes it
  // (WhatsApp group, etc) — a guest opening it lands on the public
  // registration page (event-public.service.ts / G2), which creates a
  // Guest+Invite for them and hands them into the same RSVP flow every
  // other guest uses. The link itself carries Event.shareToken, never
  // the raw Event.id: a cuid in a public URL would let anyone enumerate
  // events by guessing, and could never be revoked once shared
  // somewhere it shouldn't be — same reasoning as MemoryHub.shareToken.
  // Generated lazily on first request rather than at creation/publish
  // time — most events never get a share link requested at all (private
  // by default), so there's no reason to mint one nobody asked for.
  getShareLink: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<{ url: string }> => {
    const event = await eventService.getById(id, requestingRole, tenantId);
    assertEventIsPublished(event.status);
    if (event.visibility !== 'PUBLIC') {
      throw new HttpError(400, 'Share links are only available for public events — private events use individual invites instead.');
    }

    const shareToken = event.shareToken ?? (await eventRepository.generateShareToken(id, userId)).shareToken;
    return { url: `${process.env.FRONTEND_BASE_URL}/register?token=${shareToken}` };
  },

  // Explicit regenerate (Task-parallel to Memory Hub's regenerateShareLink)
  // — overwrites the token, so the previous link stops resolving to
  // anything. An organiser reaches for this after a link leaked
  // somewhere it shouldn't have (posted publicly, shared with the wrong
  // group) and needs the old one dead without waiting for anything else
  // to change.
  regenerateShareLink: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<{ url: string }> => {
    const event = await eventService.getById(id, requestingRole, tenantId);
    assertEventIsPublished(event.status);
    if (event.visibility !== 'PUBLIC') {
      throw new HttpError(400, 'Share links are only available for public events — private events use individual invites instead.');
    }

    const updated = await eventRepository.generateShareToken(id, userId);
    return { url: `${process.env.FRONTEND_BASE_URL}/register?token=${updated.shareToken}` };
  },

  // ─────────────────────────────────────────
  //  PUBLISH — DRAFT → PUBLISHED
  //
  //  The one and only way an event goes live. There is deliberately no
  //  UNPUBLISH: once invites may have gone out, every already-sent
  //  link (SMS especially) points at an event that must stay real.
  //  Even gating an unpublish on "no invite delivered yet" leaves a
  //  race — dispatch is sequential, so a batch could be mid-flight
  //  when the check runs — for a reversal nothing in the product
  //  actually asks for (an organiser who published too early can
  //  simply fix details in place, or use cancel() below if the event
  //  itself needs to stop). Cancel is the one-way-door escape hatch;
  //  publish has none, by design.
  // ─────────────────────────────────────────
  publish: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = await eventService.getById(id, requestingRole, tenantId); // effective status

    if (event.status !== 'DRAFT') {
      const messages: Partial<Record<EventStatus, string>> = {
        PUBLISHED: 'This event has already been published.',
        COMPLETED: 'This event has already taken place and can no longer be published.',
        CANCELLED: 'This event has been cancelled and can no longer be published.',
      };
      throw new HttpError(409, messages[event.status] ?? `Only a draft event can be published (current status: ${event.status}).`);
    }

    const missing: string[] = [];
    if (!event.name?.trim()) missing.push('a name');
    if (!event.eventDays.length) missing.push('at least one event day');
    // The venue belongs to each day. A day can only be SAVED with one now,
    // but a day that came through the venue migration from an event that
    // had none still exists without one — and guests must not be invited
    // to a day with nowhere to go.
    const daysWithoutVenue = event.eventDays.filter((d) => !d.location?.trim() || !d.address?.trim());
    if (daysWithoutVenue.length) {
      missing.push(`a venue for ${daysWithoutVenue.map((d) => `'${d.label}'`).join(', ')}`);
    }
    if (missing.length) {
      throw new HttpError(422, `This event isn't ready to publish yet — it's missing: ${missing.join(', ')}.`);
    }

    // Re-checked here, not just at create/update: the tenant's
    // subaccount can regress from ACTIVE to FAILED between when a PAID
    // event was created and when it's published (a rejected bank-detail
    // update attempt) — see payment-account-readiness.util.ts.
    assertPaidTicketingAvailable(event.ticketing);
    assertPublicEventsAvailable(event.visibility);
    if (event.ticketing === 'PAID') {
      await assertEventReadyToSellTickets(event);
    }

    await eventRepository.updateStatus(id, userId, 'PUBLISHED');
    return eventService.getById(id, requestingRole, tenantId);
  },

  // ─────────────────────────────────────────
  //  CANCEL — DRAFT/PUBLISHED/(effectively-)COMPLETED → CANCELLED
  //
  //  Not reversible — there is no un-cancel. Guests may already have
  //  been told, so recovering from a mistaken cancel is a support
  //  matter, not a self-service one. Cancelling does not archive the
  //  event or its guests and does not delete anything; it only blocks
  //  outbound actions (Task 3) and marks the event. Guests are not
  //  notified here — that needs the (unbuilt) Announcements feature —
  //  and ticketed events don't trigger a refund here either — that
  //  needs the (unbuilt) payment integration. Both are out of scope.
  // ─────────────────────────────────────────
  cancel: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = await eventService.getById(id, requestingRole, tenantId); // effective status

    if (event.status === 'CANCELLED') {
      throw new HttpError(409, 'This event has already been cancelled.');
    }

    await eventRepository.updateStatus(id, userId, 'CANCELLED');
    return eventService.getById(id, requestingRole, tenantId);
  },
};