import { renderBrandEmailShell } from '../../shared/messaging/email.engine.js';
import { normalizeSmsPunctuation } from '../../shared/messaging/sms-segments.util.js';
import { escapeHtml } from '../../shared/utils/html.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';

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

// ─────────────────────────────────────────
//  REMINDERS
//
//  An invitation says "you are invited"; a reminder says "we have not
//  heard from you". Same RSVP link and same brand shell, different words —
//  and the deadline, when there is one, is the reason to act now, so it
//  leads. No template customisation by design (out of scope).
// ─────────────────────────────────────────

export const buildReminderEmailSubject = (eventName: string): string =>
  `Reminder: please RSVP to ${eventName}`;

// Unlike buildInviteEmailHtml, organiser-typed values are HTML-escaped here.
export const buildReminderEmailHtml = (
  eventName: string,
  location: string,
  dateLabel: string | null,
  rsvpDeadline: Date | null,
  rsvpLink: string
): string =>
  renderBrandEmailShell(
    "We haven't heard from you yet",
    `
      <p>You were invited to <strong>${escapeHtml(eventName)}</strong>, and we haven't received your RSVP yet.</p>
      ${rsvpDeadline
        ? `<p style="color: #1A1A2E;"><strong>Please respond by ${formatGuestDate(rsvpDeadline)}</strong> — RSVPs close after that.</p>`
        : '<p style="color: #1A1A2E;">Please let us know whether you can make it.</p>'}
      ${dateLabel ? `<p style="color: #1A1A2E;"><strong>Date:</strong> ${dateLabel}</p>` : ''}
      <p style="color: #1A1A2E;"><strong>Venue:</strong> ${escapeHtml(location)}</p>
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

// Segments cost money, and the RSVP link alone (base URL + a 64-character
// token) is ~105 characters of a 160-character segment. So the wording is
// as short as it can be while still saying "reminder", naming the event
// and giving the deadline; the fuller "we haven't heard from you" lives in
// the email. Plain ASCII only — a single non-GSM character (curly
// apostrophes from phone keyboards are the usual culprit) would drop the
// whole message to UCS-2's 70-character segments, so punctuation is
// normalised, and the event name is capped so a very long one cannot push
// the message past two segments.
const MAX_SMS_EVENT_NAME_LENGTH = 40;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

// "20 Sep" — no year (a reminder is about the coming weeks) and no
// zero-padding, which en-ZA's own short format would add. Read in the same
// timezone formatGuestDate uses, so the SMS and the RSVP page agree.
const formatSmsDate = (date: Date): string => `${date.getDate()} ${MONTHS[date.getMonth()]}`;

export const buildReminderSmsBody = (eventName: string, rsvpLink: string, rsvpDeadline: Date | null): string => {
  const name = normalizeSmsPunctuation(eventName).trim();
  const shortName = name.length > MAX_SMS_EVENT_NAME_LENGTH
    ? `${name.slice(0, MAX_SMS_EVENT_NAME_LENGTH - 3).trimEnd()}...`
    : name;
  // "please" is dropped from the deadline variant: it costs 7 characters,
  // which decides which side of the 160 limit typical names (~20-25
  // characters) land on — measured, not guessed, against the invitation SMS.
  return rsvpDeadline
    ? `Reminder: RSVP to ${shortName} by ${formatSmsDate(rsvpDeadline)}. ${rsvpLink}`
    : `Reminder: please RSVP to ${shortName}. ${rsvpLink}`;
};
