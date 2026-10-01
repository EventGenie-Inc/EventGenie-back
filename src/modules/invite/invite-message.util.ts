import { renderBrandEmailShell } from '../../shared/messaging/email.engine.js';
import { normalizeSmsPunctuation } from '../../shared/messaging/sms-segments.util.js';
import { escapeHtml } from '../../shared/utils/html.util.js';
import { formatGuestDate, formatGuestDateShort } from '../../shared/utils/guest-date.util.js';

// Domain-aware content builders — this is where "invite"/"event"/"RSVP
// link" concepts live, as opposed to the domain-ignorant engines. No
// frontend route is confirmed to exist yet for the guest-facing RSVP page
// (rsvp.router.ts is API-only: GET /validate/:token, POST /submit) — this
// path is a best-guess placeholder, matching the only prior convention
// found in git history (an old, removed WhatsApp-integration commit used
// `/rsvp?token=...`). Flagged as unconfirmed in the final report.
//
// HTML ESCAPING — every organiser-typed value interpolated into an HTML
// email body below (eventName, and each day's label, venue name and
// address) goes through escapeHtml
// (shared/utils/html.util.ts) before reaching renderBrandEmailShell: an
// event named `<script>...` or containing `"` must not become live markup
// or break out of a style attribute in a guest's inbox, sent under
// EventGenie's own From address. dateLabel is NOT escaped — it is derived
// from EventDay.date (guest-date.util.ts), never free text a user types.
// rsvpLink is NOT escaped either — it is server-built from
// FRONTEND_BASE_URL (env config) and a crypto.randomBytes(32) hex token
// (invite.repository.ts), never user input, so it can't carry HTML or
// attribute-breaking characters by construction. Both exemptions are
// deliberate, not oversights — re-check them if either value's source
// ever changes to accept free text.
export const buildInviteRsvpLink = (token: string): string =>
  `${process.env.FRONTEND_BASE_URL}/rsvp?token=${token}`;

// ─────────────────────────────────────────
//  WHEN AND WHERE — per guest, from THEIR invited days
//
//  The venue belongs to each event day, and a guest may be invited to a
//  subset of an event's days, so the "when and where" of an invitation or
//  reminder is built per guest from their own days (invite-dispatch.service.ts
//  passes them in, archived days already excluded):
//    - one invited day  → a Date line and a Venue line
//    - several          → one line per day: label, date, venue
//    - none (defensive: every invite is created with at least one day, but
//      its only day could since have been archived) → the event's earliest
//      date, if there is one, and no venue line rather than a wrong one.
// ─────────────────────────────────────────
export interface InviteDayLine {
  label: string;
  date: Date;
  location: string | null;
  address: string | null;
}

const venueText = (day: InviteDayLine): string | null => {
  const parts = [day.location?.trim(), day.address?.trim()].filter((p): p is string => !!p);
  return parts.length ? escapeHtml(parts.join(', ')) : null;
};

const LINE = 'style="color: #1A1A2E;"';

export const buildWhenAndWhereHtml = (days: InviteDayLine[], fallbackDateLabel: string | null): string => {
  if (days.length === 0) {
    return fallbackDateLabel ? `<p ${LINE}><strong>Date:</strong> ${fallbackDateLabel}</p>` : '';
  }
  if (days.length === 1) {
    const day = days[0]!;
    const venue = venueText(day);
    return `<p ${LINE}><strong>Date:</strong> ${formatGuestDate(day.date)}</p>` +
      (venue ? `<p ${LINE}><strong>Venue:</strong> ${venue}</p>` : '');
  }
  const lines = days.map((day) => {
    const venue = venueText(day);
    return `<p ${LINE}><strong>${escapeHtml(day.label)}</strong> — ${formatGuestDate(day.date)}${venue ? ` — ${venue}` : ''}</p>`;
  });
  return `<p ${LINE}><strong>Your days:</strong></p>${lines.join('')}`;
};

export const buildInviteEmailSubject = (eventName: string): string =>
  `You're invited to ${eventName}!`;

export const buildInviteEmailHtml = (
  eventName: string,
  days: InviteDayLine[],
  fallbackDateLabel: string | null,
  rsvpLink: string
): string =>
  renderBrandEmailShell(
    "You're invited!",
    `
      <p>You've been invited to <strong>${escapeHtml(eventName)}</strong>.</p>
      ${buildWhenAndWhereHtml(days, fallbackDateLabel)}
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

// Same escaping as buildInviteEmailHtml above — see this file's header.
export const buildReminderEmailHtml = (
  eventName: string,
  days: InviteDayLine[],
  fallbackDateLabel: string | null,
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
      ${buildWhenAndWhereHtml(days, fallbackDateLabel)}
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

export const buildReminderSmsBody = (eventName: string, rsvpLink: string, rsvpDeadline: Date | null): string => {
  const name = normalizeSmsPunctuation(eventName).trim();
  const shortName = name.length > MAX_SMS_EVENT_NAME_LENGTH
    ? `${name.slice(0, MAX_SMS_EVENT_NAME_LENGTH - 3).trimEnd()}...`
    : name;
  // "please" is dropped from the deadline variant: it costs 7 characters,
  // which decides which side of the 160 limit typical names (~20-25
  // characters) land on — measured, not guessed, against the invitation SMS.
  return rsvpDeadline
    ? `Reminder: RSVP to ${shortName} by ${formatGuestDateShort(rsvpDeadline)}. ${rsvpLink}`
    : `Reminder: please RSVP to ${shortName}. ${rsvpLink}`;
};
