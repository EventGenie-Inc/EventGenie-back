import { eventRepository } from './event.repository.js';
import { type CreateEventDto, type UpdateEventDto } from './event.types.js';
import { type PlatformRole, type EventStatus } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertEventCreatable, assertEventUpdatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { withEffectiveStatus, assertEventIsPublished } from './event-status.util.js';

export const eventService = {

  // Both list and detail flow through the SAME withEffectiveStatus
  // presenter, so they can never disagree about a given event's
  // status — there is no separate code path either could drift from.
  getAll: async (requestingRole: PlatformRole, tenantId: string | null) => {
    const events = requestingRole === 'SUPER_ADMIN'
      ? await eventRepository.findAll()
      : await eventRepository.findAll(tenantId ?? undefined);
    return events.map(withEffectiveStatus);
  },

  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = requestingRole === 'SUPER_ADMIN'
      ? await eventRepository.findById(id)
      : await eventRepository.findById(id, tenantId ?? undefined);

    if (!event) throw new HttpError(404, 'Event not found');
    return withEffectiveStatus(event);
  },

  create: async (tenantId: string, userId: string, data: CreateEventDto) => {
    await assertEventCreatable(tenantId, {
      ...(data.visibility !== undefined && { visibility: data.visibility }),
      ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
    });
    return eventRepository.create(tenantId, userId, data);
  },

  update: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDto) => {
    // Tier rules are evaluated against the EVENT's owning tenant, not the
    // requester's — a SUPER_ADMIN editing a SPARK tenant's event must still
    // be bound by that tenant's plan, and a SUPER_ADMIN has no tenantId of
    // their own to fall back on.
    const event = await eventService.getById(id, requestingRole, tenantId);
    await assertEventUpdatable(event.tenantId, {
      ...(data.visibility !== undefined && { visibility: data.visibility }),
      ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
    });
    await eventRepository.update(id, userId, data);
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

  // PUBLIC-only: the organiser copies this link, no per-guest token or
  // guest record involved. NOTE: no guest self-registration flow exists
  // yet anywhere in the codebase (confirmed — rsvp.router.ts is entirely
  // token-driven via a pre-existing Invite), so this endpoint returns a
  // URL contract only; nothing on the backend currently resolves it into
  // a working RSVP for a stranger holding the link. That flow is out of
  // scope here.
  getShareLink: async (id: string, requestingRole: PlatformRole, tenantId: string | null): Promise<{ url: string }> => {
    const event = await eventService.getById(id, requestingRole, tenantId);
    assertEventIsPublished(event.status);
    if (event.visibility !== 'PUBLIC') {
      throw new HttpError(400, 'Share links are only available for public events — private events use individual invites instead.');
    }
    return { url: `${process.env.FRONTEND_BASE_URL}/rsvp?eventId=${event.id}` };
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
    if (!event.location?.trim()) missing.push('a location');
    if (!event.eventDays.length) missing.push('at least one event day');
    if (missing.length) {
      throw new HttpError(422, `This event isn't ready to publish yet — it's missing: ${missing.join(', ')}.`);
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