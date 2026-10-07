import { rsvpResponseRepository } from './rsvp-response.repository.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { eventService } from '../event/event.service.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';

// RsvpResponse has no tenantId and no eventId of its own: it scopes
// through the invite in its URL, then that invite's event, gated on
// eventService.getScoped (tenant AND the assignment lock). Before the Team
// Members batch these two reads did no scoping at all: any EVENT_ADMIN
// could read any tenant's custom RSVP answers by invite id.
const assertInviteVisible = async (inviteId: string, requestingRole: PlatformRole, tenantId: string | null) => {
  const invite = await inviteRepository.findById(inviteId);
  if (!invite) throw new HttpError(404, 'Invite not found');
  await eventService.getScoped(invite.eventId, requestingRole, tenantId);
};

export const rsvpResponseService = {

  getAll: async (inviteId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await assertInviteVisible(inviteId, requestingRole, tenantId);
    return rsvpResponseRepository.findAll(inviteId);
  },

  // The response must belong to the invite in the URL, not merely to a
  // visible one (STEERING: a sub-resource belongs to the record in its URL).
  getById: async (inviteId: string, id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await assertInviteVisible(inviteId, requestingRole, tenantId);
    const response = await rsvpResponseRepository.findById(id);
    if (!response || response.inviteId !== inviteId) throw new HttpError(404, 'RSVP response not found');
    return response;
  },
};
