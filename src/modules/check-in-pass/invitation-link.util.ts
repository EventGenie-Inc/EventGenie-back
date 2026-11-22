import { frontendOrigin } from '../../shared/utils/frontend-url.util.js';
import { isShortCodeShaped } from '../invite/invite-short-code.service.js';

// ─────────────────────────────────────────
//  "THIS IS THE INVITATION, NOT THE CHECK-IN CODE"
//
//  Guests already carry a QR code of their invitation link (invite-qr.util.ts:
//  exactly buildInviteRsvpLink, <FRONTEND_BASE_URL>/rsvp?token=<token>, in
//  every invitation, reminder and registration email and on the invitation
//  page), and at the door many will show that one. Their text messages carry
//  the short link <FRONTEND_BASE_URL>/r/<10-character code> instead, which a
//  phone can also turn into a QR. Both are recognised here by their SHAPE
//  only, so the scanner can say what it is.
//
//  Shape, never lookup: the token or code is never resolved, so the answer
//  is the same for a real invitation, another event's and a made-up one, and
//  the scanner can't be used to probe invitations. Nothing here logs.
//
//  Accepted: http or https or no scheme at all; the configured frontend's host
//  or any e-velope.co.za host (an invitation sent from another environment,
//  or before a domain change, still reads as one); a trailing slash; the
//  path at the end of any base path. /rsvp needs a `token` parameter (any
//  value); /r/ needs a code of the short link's shape.
// ─────────────────────────────────────────

const MAX_LINK_LENGTH = 2048;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const RSVP_PATH = /(?:^|\/)rsvp\/?$/;
const SHORT_LINK_PATH = /(?:^|\/)r\/([^/]+)\/?$/;

const configuredHost = (): string | null => {
  try {
    return new URL(frontendOrigin()).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isOurHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return host === configuredHost() || host === 'e-velope.co.za' || host.endsWith('.e-velope.co.za');
};

export const isInvitationLink = (payload: unknown): boolean => {
  if (typeof payload !== 'string') return false;
  const text = payload.trim();
  if (!text || text.length > MAX_LINK_LENGTH) return false;

  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return false;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !isOurHost(url.hostname)) return false;

  if (RSVP_PATH.test(url.pathname)) return url.searchParams.has('token');
  const short = SHORT_LINK_PATH.exec(url.pathname);
  return !!short && isShortCodeShaped(short[1]!);
};
