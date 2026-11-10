import { type InlineImage } from '../../shared/messaging/email.engine.js';
import { qrCodePng } from '../../shared/utils/qr-code.util.js';
import { buildInviteRsvpLink } from './invite-message.util.js';

// ─────────────────────────────────────────
//  THE GUEST'S QR CODE
//
//  Exactly the guest's own invitation link (buildInviteRsvpLink), the same
//  link as the email's button, so it opens nothing the link doesn't: a
//  removed, pending or declined guest's token is refused by the page like
//  any unknown one, and the code simply stops working with it.
//
//  In the guest emails (invitation, reminder, registration) it is an inline
//  attachment (the layout's `qr` block); the invitation page asks for it
//  with POST /api/rsvp/qr (rsvp.service.ts's getInviteQr).
// ─────────────────────────────────────────

export const INVITE_QR_CONTENT_ID = 'invite-qr';
export const INVITE_QR_FILENAME = 'e-velope-qr.png';

export const inviteQrPng = (token: string): Promise<Buffer> => qrCodePng(buildInviteRsvpLink(token));

export const inviteQrImage = async (token: string): Promise<InlineImage> => ({
  contentId: INVITE_QR_CONTENT_ID,
  filename: INVITE_QR_FILENAME,
  contentType: 'image/png',
  content: await inviteQrPng(token),
});
