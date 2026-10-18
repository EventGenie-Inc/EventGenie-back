import { inviteRepository } from './invite.repository.js';
import { guestRepository } from '../guest/guest.repository.js';
import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';

// Invite has no tenantId of its own — ownership is transitive through its
// direct eventId -> Event -> tenantId, exactly like event-day/guest. Every
// method now gates through eventService.getById() (Part 2 — this was
// deferred from Part 1.5 until the Control Center made these reachable).
//
// An invite under /api/events/:eventId/invites/:id must be THAT event's:
// the URL's event is gated first (tenant scoping and the assignment lock),
// then a 404 unless the invite's own eventId matches, so the same tenant's
// other event's invite is the same 404 as another tenant's (STEERING "A
// sub-resource must belong to the event in its URL"). These used to gate
// only on the invite's own event.
const inviteInScope = async (eventId: string, id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
  await eventService.getById(eventId, requestingRole, tenantId);
  const invite = await inviteRepository.findById(id, includeArchived);
  if (!invite || invite.eventId !== eventId) throw new HttpError(404, 'Invite not found');
  return invite;
};

export const inviteService = {
  getAll: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getById(eventId, requestingRole, tenantId); // throws 404 if wrong tenant
    return inviteRepository.findAll(eventId);
  },

  getById: (eventId: string, id: string, requestingRole: PlatformRole, tenantId: string | null) =>
    inviteInScope(eventId, id, requestingRole, tenantId),

  create: async (
    eventId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: CreateInviteDto
  ) => {
    await eventService.getById(eventId, requestingRole, tenantId);

    // Closes a cross-tenant/cross-event hole: guestId was never verified
    // to belong to eventId, so an invite could previously be attached to
    // another tenant's guest.
    const guest = await guestRepository.findById(data.guestId);
    if (!guest || guest.eventId !== eventId) {
      throw new HttpError(400, `Guest '${data.guestId}' does not belong to this event`);
    }

    return inviteRepository.create(eventId, userId, data);
  },

  update: async (
    eventId: string,
    id: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: UpdateInviteDto
  ) => {
    await inviteInScope(eventId, id, requestingRole, tenantId);
    return inviteRepository.update(id, userId, data);
  },

  // Archiving an invite does NOT archive its guest — the guest still
  // exists and may be re-invited later. Invite already carries its own
  // eventId, so ownership is a direct one-hop gate via eventService.getById,
  // same shape as event-day.service.ts.
  archive: async (eventId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await inviteInScope(eventId, id, requestingRole, tenantId);
    return inviteRepository.archive(id, userId);
  },

  reactivate: async (eventId: string, id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // Must look up including archived — the whole point of reactivate is
    // to find an invite that is currently archived and un-archive it.
    await inviteInScope(eventId, id, requestingRole, tenantId, true);
    return inviteRepository.reactivate(id, userId);
  },
};