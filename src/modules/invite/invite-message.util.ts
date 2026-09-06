import { renderBrandEmailShell } from '../../shared/messaging/email.engine.js';

// Domain-aware content builders — this is where "invite"/"event"/"RSVP
// link" concepts live, as opposed to the domain-ignorant engines. No
// frontend route is confirmed to exist yet for the guest-facing RSVP page
// (rsvp.router.ts is API-only: GET /validate/:token, POST /submit) — this
// path is a best-guess placeholder, matching the only prior convention
// found in git history (an old, removed WhatsApp-integration commit used
// `/rsvp?token=...`). Flagged as unconfirmed in the final report.
export const buildInviteRsvpLink = (token: string): string =>
  `${process.env.FRONTEND_BASE_URL}/rsvp?token=${token}`;

export const buildInviteEmailSubject = (eventName: string): string =>
  `You're invited to ${eventName}!`;

export const buildInviteEmailHtml = (
  eventName: string,
  location: string,
  dateLabel: string | null,
  rsvpLink: string
): string =>
  renderBrandEmailShell(
    "You're invited!",
    `
      <p>You've been invited to <strong>${eventName}</strong>.</p>
      ${dateLabel ? `<p style="color: #1A1A2E;"><strong>Date:</strong> ${dateLabel}</p>` : ''}
      <p style="color: #1A1A2E;"><strong>Venue:</strong> ${location}</p>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${rsvpLink}" style="
          display: inline-block;
          padding: 14px 32px;
          background: #C6A43A;
          color: #1A1A2E;
          font-weight: bold;
          text-decoration: none;
          border-radius: 8px;
        ">
          RSVP Now
        </a>
      </div>
      <p style="color: #6B6B80; font-size: 14px;">
        If the button doesn't work, copy and paste this link: ${rsvpLink}
      </p>
    `
  );

export const buildInviteSmsBody = (eventName: string, rsvpLink: string): string =>
  `You're invited to ${eventName}! RSVP: ${rsvpLink}`;
