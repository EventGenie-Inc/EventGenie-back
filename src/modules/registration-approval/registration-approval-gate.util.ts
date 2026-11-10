import { type Prisma } from '@prisma/client';

// ─────────────────────────────────────────
//  WHO A TOKEN STILL OPENS ANYTHING FOR
//
//  On an event with registrationAutoApprove off, a registrant (and each of
//  their plus-ones) is saved with Guest.pendingApproval set until the
//  organiser approves or declines. Until approved nothing about the event
//  may reach them: no invitation email, no online link, no program, no
//  guest view, no photo album, even if they somehow hold a token. Declined
//  (registrationDeclinedAt) is never approved either.
//
//  A guest an organiser has removed (archived) is shut out the same way:
//  removing someone from the guest list ends their access, and restoring
//  them opens it again. So is an archived INVITE, whatever its guest (an
//  organiser can archive one invite and keep the guest): its token is an
//  unknown one until the invite is restored. Until 2026-11 an archived
//  invite's link still opened the invitation.
//
//  Every query that resolves an invite TOKEN adds INVITE_TOKEN_USABLE to
//  its `where`, so such a token is exactly an unknown one (the same 404,
//  the same words): invite.repository.ts's findByToken (RSVP validate,
//  ticket quote and payment, program, Memory Hub guest routes, guest
//  feedback, storage guest-release), its findTokenForQr (the invitation
//  page's QR code, POST /api/rsvp/qr), rsvp.service.ts's submit,
//  guest-document.repository.ts's upload, and check-in's QR lookup.
//
//  Every query that picks guests to EMAIL adds GUEST_NOT_AWAITING_APPROVAL
//  (announcements, invitation sends, reminders), and check-in's door list
//  leaves them out too. The one exception is the cancellation email:
//  pending registrants get it, without the organiser's note
//  (announcement.service.ts's cancelEvent).
// ─────────────────────────────────────────

export const GUEST_NOT_AWAITING_APPROVAL = {
  pendingApproval: false,
  registrationDeclinedAt: null,
} as const satisfies Prisma.GuestWhereInput;

export const INVITE_TOKEN_USABLE = {
  isArchived: false,
  guest: { isArchived: false, ...GUEST_NOT_AWAITING_APPROVAL },
} as const satisfies Prisma.InviteWhereInput;
