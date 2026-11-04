import { rsvpResponseRepository } from './rsvp-response.repository.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { eventService } from '../event/event.service.js';
import { type PlatformRole, type RsvpFieldType } from '@prisma/client';
import { answerValue } from '../rsvp/rsvp-answers.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { guestDocumentService } from '../guest-document/guest-document.service.js';

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

const withChoices = <T extends { value: string; rsvpField: { fieldType: RsvpFieldType } }>(response: T) => ({
  ...response,
  value: answerValue(response.rsvpField.fieldType, response.value),
});

export const rsvpResponseService = {

  // Each answer carries `document`: for a DOCUMENT question, the received
  // file's name, type, size and upload time while it is kept, else null
  // (guest-document.service.ts's withDocumentInfo). Never a link: the
  // organiser asks GET /api/events/:eventId/documents/:id/link for one.
  // A MULTI_SELECT answer's `value` is its list of chosen options
  // (rsvp-answers.util.ts's answerValue); every other answer's is text.
  getAll: async (inviteId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await assertInviteVisible(inviteId, requestingRole, tenantId);
    return (await guestDocumentService.withDocumentInfo(await rsvpResponseRepository.findAll(inviteId))).map(withChoices);
  },

  // The response must belong to the invite in the URL, not merely to a
  // visible one (STEERING: a sub-resource belongs to the record in its URL).
  getById: async (inviteId: string, id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await assertInviteVisible(inviteId, requestingRole, tenantId);
    const response = await rsvpResponseRepository.findById(id);
    if (!response || response.inviteId !== inviteId) throw new HttpError(404, 'RSVP response not found');
    const [withDocument] = await guestDocumentService.withDocumentInfo([response]);
    return withChoices(withDocument!);
  },
};
