import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import { type EventStatus } from '@prisma/client';
import { type CreateEventDto, type UpdateEventDto } from './event.types.js';
import { withPlainCoordinates } from './event-coordinates.util.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
import { eventAssignmentRepository } from '../event-assignment/event-assignment.repository.js';

// A blank host name means "no host line" — stored as null, never "", the
// same as the wizard's materialize path (event-draft.service.ts) has always
// done. Trimmed so "  Sarah & Tom " doesn't print with stray spaces.
export const normalizeHostName = (hostName: string | null | undefined): string | null => {
  const trimmed = typeof hostName === 'string' ? hostName.trim() : '';
  return trimmed ? trimmed : null;
};

// The ownership + archive filter for a lookup of ONE event by id. Every
// by-id read below — the full findById AND the lean variants — builds its
// `where` here, so what a lookup REFUSES (another tenant's event, an archived
// one) is decided in exactly one place and cannot drift between them. This is
// the tenant-isolation boundary for nearly every organiser endpoint; do not
// inline a second copy of it.
//
// eventIds is the assignment lock (event-assignment-lock.util.ts): when
// present, the event must ALSO be one of these, so a locked EVENT_ADMIN's
// unassigned event is the same null (404) as another tenant's. Absent means
// no lock. Supplied by eventService's resolveEventScope, never by hand.
const scopedWhere = (id: string, includeArchived: boolean, tenantId?: string, eventIds?: string[]) => ({
  id,
  ...(includeArchived ? {} : { isArchived: false }),
  ...(tenantId ? { tenantId } : {}),
  ...(eventIds ? { AND: [{ id: { in: eventIds } }] } : {}),
});

export const eventRepository = {

  // Every method below that returns an Event row passes it through
  // withPlainCoordinates (event-coordinates.util.ts — see its header for
  // why): Decimal columns must not reach a caller or a JSON response.

  // eventIds: the assignment lock, as in scopedWhere above.
  findAll: async (tenantId?: string, includeArchived = false, eventIds?: string[]) =>
    (
      await prisma.event.findMany({
        where: {
          ...(includeArchived ? {} : { isArchived: false }),
          ...(tenantId ? { tenantId } : {}),
          ...(eventIds ? { id: { in: eventIds } } : {}),
        },
        // Ordered by date so "the first day" — whose venue an organiser
        // list shows, now that the venue belongs to the day — is stable.
        include: { eventDays: { where: { isArchived: false }, orderBy: { date: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      })
    ).map(withPlainCoordinates),

  findById: async (id: string, includeArchived = false, tenantId?: string, eventIds?: string[]) => {
    const event = await prisma.event.findFirst({
      where: scopedWhere(id, includeArchived, tenantId, eventIds),
      include: {
        eventDays: { where: { isArchived: false }, orderBy: { date: 'asc' } },
        memoryHub: true,
        tickets: { where: { isArchived: false } },
        rsvpFields: { where: { isArchived: false }, orderBy: { order: 'asc' } },
        program: {
          include: {
            programItems: { where: { isArchived: false }, orderBy: { order: 'asc' } },
          },
        },
        // Event Pass batch — included alongside eventDays (already here)
        // so every event-scoped tier check that receives this object can
        // resolve entitlement (event-entitlement.util.ts's
        // EntitlementDerivableEvent) with no extra query.
        eventPass: true,
      },
    });
    return event ? withPlainCoordinates(event) : null;
  },

  // LEAN ownership lookup — the same row and the same `scopedWhere` as
  // findById, with only the relations the ownership gate itself needs:
  // eventDays, because the effective status (COMPLETED is derived from the
  // last day, see event-status.util.ts) cannot be resolved without them.
  // findById above pulls six more relations (memoryHub, tickets, rsvpFields,
  // program, programItems, eventPass — each its own query) that most callers
  // never read. See eventService.getScoped for which callers may use this.
  //
  // Deliberately `include`, not a column `select`: the event row is ONE query
  // whichever columns it carries, so trimming columns would save bytes, not
  // round trips, and would force every caller that reads a scalar
  // (visibility, name, rsvpDeadline, ...) onto the heavy variant. What the
  // lean variant drops is the RELATIONS — that is where the cost is.
  findScoped: async (id: string, includeArchived = false, tenantId?: string, eventIds?: string[]) => {
    const event = await prisma.event.findFirst({
      where: scopedWhere(id, includeArchived, tenantId, eventIds),
      include: { eventDays: { where: { isArchived: false } } },
    });
    return event ? withPlainCoordinates(event) : null;
  },

  // findScoped plus the Event Pass — what resolveEventEntitlement needs
  // (EntitlementDerivableEvent = tenantId + eventPass + eventDays), so a tier
  // check can run without the other relations.
  findScopedWithPass: async (id: string, includeArchived = false, tenantId?: string, eventIds?: string[]) => {
    const event = await prisma.event.findFirst({
      where: scopedWhere(id, includeArchived, tenantId, eventIds),
      include: { eventDays: { where: { isArchived: false } }, eventPass: true },
    });
    return event ? withPlainCoordinates(event) : null;
  },

  // Event Pass batch: `eventPass: null` excludes any event that has EVER
  // held a pass, permanently — not just while a pass is currently
  // active. See event-entitlement.util.ts / the batch report for why
  // this is permanent rather than re-counting the moment a pass expires
  // (a retroactive maxEvents penalty the "expiry grandfathers, it does
  // not break" principle argues against).
  countActive: (tenantId: string) =>
    prisma.event.count({ where: { tenantId, isArchived: false, eventPass: null } }),

  // Public self-registration entry point (G2) — resolves an event from
  // its unguessable shareToken alone, no tenant/session context
  // involved. eventDays included so resolveEffectiveStatus can be
  // computed before anything goes out to a guest's browser, exactly
  // like memoryHubRepository.findByShareToken's equivalent include.
  findByShareToken: async (shareToken: string) => {
    const event = await prisma.event.findFirst({
      where: { shareToken, isArchived: false },
      // eventPass included alongside eventDays — event-public.service.ts's
      // register() calls assertGuestsCreatable, which is event-scoped
      // (Event Pass batch) and needs both to resolve entitlement.
      include: { eventDays: { where: { isArchived: false }, orderBy: { date: 'asc' } }, eventPass: true },
    });
    return event ? withPlainCoordinates(event) : null;
  },

  // Generates (or regenerates, overwriting whatever was there) the
  // public share token — 32 random bytes hex, matching invite/Memory
  // Hub token generation exactly. Regenerating invalidates the old link
  // by construction: the column is overwritten, so the previous value
  // simply stops matching anything.
  generateShareToken: (id: string, userId: string) =>
    prisma.event
      .update({
        where: { id },
        data: { shareToken: crypto.randomBytes(32).toString('hex'), updatedBy: userId },
      })
      .then(withPlainCoordinates),

  // Accepted invites ≈ accepted guests: createWithInvite/bulkCreateWithInvites
  // (guest.repository.ts) create exactly one Invite per Guest, and
  // rsvp.service.ts's submit() flips that SAME invite's status rather than
  // creating a new one — so this never double-counts a guest who RSVP'd.
  // Plus-ones (rsvp.service.ts) keep the same 1:1 invariant — each gets
  // its own Guest+Invite pair, created already ACCEPTED — so they're
  // included here deliberately: they occupy a seat, so they count toward
  // the venue-capacity indicator this feeds (acceptedGuestCount).
  countAcceptedInvitesForEvent: (eventId: string) =>
    prisma.invite.count({ where: { eventId, isArchived: false, status: 'ACCEPTED' } }),

  // Wrapped in a transaction so the event never exists without a
  // MemoryHub — the wizard's materialize path (event-draft.service.ts)
  // already created one; this direct-POST path did not (Memory Hub
  // batch found this gap: "an event without a hub would fail silently
  // the moment someone tries to open it" — confirmed 0 live events were
  // missing one only because none had come through this path yet).
  //
  // assignCreator: the creator is a locked EVENT_ADMIN (eventService.create
  // decides), so they're assigned to the new event in the same transaction —
  // otherwise they'd create an event they can't open.
  create: (tenantId: string, userId: string, data: CreateEventDto, assignCreator = false) =>
    prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          tenantId,
          createdByUserId: userId,
          name: data.name,
          // Optional fields must be null (not undefined) for exactOptionalPropertyTypes
          description: data.description ?? null,
          coverImageUrl: data.coverImageUrl ?? null,
          coverImagePublicId: data.coverImagePublicId ?? null,
          status: 'DRAFT',
          visibility: data.visibility ?? 'PRIVATE',
          ticketing: data.ticketing ?? 'FREE',
          hostName: normalizeHostName(data.hostName),
          rsvpDeadline: data.rsvpDeadline ? parseClientDateTime(data.rsvpDeadline) : null,
          capacity: data.capacity ?? null,
          ticketsRefundable: data.ticketsRefundable ?? false,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      await tx.memoryHub.create({
        data: {
          eventId: event.id,
          title: null,
          description: null,
          isPublic: false,
          opensAt: null,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      if (assignCreator) {
        await eventAssignmentRepository.create(tx, tenantId, userId, event.id, userId);
      }

      return withPlainCoordinates(event);
    }),

  update: (id: string, userId: string, data: UpdateEventDto) =>
    prisma.event.update({
      where: { id },
      data: {
        // Only include fields that are explicitly provided
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description ?? null }),
        ...(data.coverImageUrl !== undefined && { coverImageUrl: data.coverImageUrl ?? null }),
        ...(data.coverImagePublicId !== undefined && { coverImagePublicId: data.coverImagePublicId ?? null }),
        ...(data.visibility !== undefined && { visibility: data.visibility }),
        ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
        ...(data.hostName !== undefined && { hostName: normalizeHostName(data.hostName) }),
        ...(data.rsvpDeadline !== undefined && { rsvpDeadline: data.rsvpDeadline ? parseClientDateTime(data.rsvpDeadline) : null }),
        ...(data.capacity !== undefined && { capacity: data.capacity ?? null }),
        ...(data.ticketsRefundable !== undefined && { ticketsRefundable: data.ticketsRefundable }),
        updatedBy: userId,
      },
    }).then(withPlainCoordinates),

  archive: (id: string, userId: string) =>
    prisma.event
      .update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
      })
      .then(withPlainCoordinates),

  // SUPER_ADMIN support action — mirrors user.repository.ts/tenant.repository.ts's
  // reactivate exactly.
  reactivate: (id: string, userId: string) =>
    prisma.event
      .update({
        where: { id },
        data: { isArchived: false, updatedBy: userId },
      })
      .then(withPlainCoordinates),

  // The only writer of Event.status — publish() and cancel() in
  // event.service.ts are the sole callers. Kept separate from the
  // generic update() above (which no longer accepts a status field at
  // all) so a status transition can never be smuggled through a plain
  // PUT /api/events/:id alongside unrelated field edits.
  updateStatus: (id: string, userId: string, status: EventStatus) =>
    prisma.event
      .update({
        where: { id },
        data: { status, updatedBy: userId },
      })
      .then(withPlainCoordinates),
};