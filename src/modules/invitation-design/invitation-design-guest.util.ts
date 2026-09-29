import { type InvitationDesign } from '@prisma/client';
import { type GuestInvitationDesign, type InvitationOverrides } from './invitation-design.types.js';

// Guest-facing projection of an InvitationDesign row, shared by
// rsvp.service.ts's validate() and event-public.service.ts's toPublicView.
// An explicit allowlist, never a spread of the row (STEERING "Guest-facing
// responses"): no id, eventId, audit fields, isArchived or
// cloudinaryPublicId. Kept apart from invitation-design.service.ts so the
// guest modules don't import eventService just for this.
export const toGuestDesign = (design: InvitationDesign | null | undefined): GuestInvitationDesign | null => {
  if (!design) return null;
  if (design.kind === 'TEMPLATE') {
    return {
      kind: 'TEMPLATE',
      templateId: design.templateId as string,
      templateVersion: design.templateVersion as number,
      overrides: design.overrides as unknown as InvitationOverrides,
    };
  }
  return {
    kind: 'UPLOAD',
    imageUrl: design.imageUrl as string,
    width: design.width as number,
    height: design.height as number,
    altText: design.altText,
  };
};
