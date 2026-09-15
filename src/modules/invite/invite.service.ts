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
export const inviteService = {
  getAll: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getById(eventId, requestingRole, tenantId); // throws 404 if wrong tenant
    return inviteRepository.findAll(eventId);
  },

  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const invite = await inviteRepository.findById(id);
    if (!invite) throw new HttpError(404, 'Invite not found');
    await eventService.getById(invite.eventId, requestingRole, tenantId);
    return invite;
  },

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
    id: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: UpdateInviteDto
  ) => {
    await inviteService.getById(id, requestingRole, tenantId); // now scoped
    return inviteRepository.update(id, userId, data);
  },

  // Archiving an invite does NOT archive its guest — the guest still
  // exists and may be re-invited later. Invite already carries its own
  // eventId, so ownership is a direct one-hop gate via eventService.getById,
  // same shape as event-day.service.ts.
  archive: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const invite = await inviteRepository.findById(id);
    if (!invite) throw new HttpError(404, 'Invite not found');
    await eventService.getById(invite.eventId, requestingRole, tenantId);
    return inviteRepository.archive(id, userId);
  },

  reactivate: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // Must look up including archived — the whole point of reactivate is
    // to find an invite that is currently archived and un-archive it.
    const invite = await inviteRepository.findById(id, true);
    if (!invite) throw new HttpError(404, 'Invite not found');
    await eventService.getById(invite.eventId, requestingRole, tenantId);
    return inviteRepository.reactivate(id, userId);
  },
};