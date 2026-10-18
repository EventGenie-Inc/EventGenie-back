import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../shared/messaging/email-address.util.js';
import { authSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';

// ─────────────────────────────────────────
//  TEAM INVITATION EMAIL
//
//  An account email, so it reads like the auth emails (auth-email.util.ts):
//  calm, one job, no seal, no e-velope wordplay. The company name and the
//  inviter's name are typed by a tenant, so they're passed as plain text
//  (renderEmail escapes them) and, in the subject, sanitised as header text.
//
//  From:   "e-velope" <RESEND_FROM_EMAIL>
//  Button: "Accept invitation" → <FRONTEND_BASE_URL>/join?token=<raw token>
//
//  The raw token exists only in this link. It's never stored (the invite
//  row keeps its SHA-256 hash, like DeviceToken) and never logged.
// ─────────────────────────────────────────

export const TEAM_INVITE_TTL_DAYS = 7;

export const teamInviteLink = (rawToken: string): string => frontendUrl(`/join?token=${encodeURIComponent(rawToken)}`);

export const buildTeamInviteEmail = (input: {
  to: string;
  companyName: string;
  inviterName: string | null;
  roleLabel: string;
  rawToken: string;
}): OutgoingEmail => {
  // The subject is a header: sanitised and capped like a sender name.
  const company = sanitizeDisplayName(input.companyName, 80) || 'a workspace';
  const subject = `You've been invited to join ${company} on e-velope`;
  const invitedBy = input.inviterName ? `${input.inviterName} has invited you` : "You've been invited";

  const { html, text } = renderEmail({
    subject,
    preheader: `Join ${input.companyName} as ${input.roleLabel}. The invitation is valid for ${TEAM_INVITE_TTL_DAYS} days.`,
    blocks: [
      { kind: 'title', text: `Join ${input.companyName} on e-velope` },
      { kind: 'paragraph', text: `${invitedBy} to join ${input.companyName} as ${input.roleLabel}.` },
      { kind: 'button', label: 'Accept invitation', href: teamInviteLink(input.rawToken) },
      { kind: 'paragraph', text: `This invitation is valid for ${TEAM_INVITE_TTL_DAYS} days and can be used once.` },
      { kind: 'paragraph', text: "If you weren't expecting this, you can ignore this email.", muted: true },
    ],
    reason: `You received this because someone at ${input.companyName} invited this email address to their team.`,
  });

  return { to: input.to, from: formatFromHeader('e-velope', authSenderAddress()), subject, html, text };
};
