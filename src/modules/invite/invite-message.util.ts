import { type InvitationDesignKind } from '@prisma/client';
import { normalizeSmsPunctuation } from '../../shared/messaging/sms-segments.util.js';
import { renderEmail, type EmailBlock } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName, sanitizeHeaderText } from '../../shared/messaging/email-address.util.js';
import { inviteSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { formatGuestDate, formatGuestDateShort, formatGuestTime } from '../../shared/utils/guest-date.util.js';

// Domain-aware content builders — this is where "invite"/"event"/"RSVP
// link" concepts live, as opposed to the domain-ignorant engines.
//
// ESCAPING — the email builders below hand renderEmail (email-layout.ts)
// plain text only: the event name, host name, each day's label, venue and
// address, the design's alt text. renderEmail escapes every one of them,
// and every URL, on the way into the HTML. Nothing here builds markup, so
// there is nothing here to forget to escape. Organiser text that reaches a
// HEADER (the From name, the subject) goes through email-address.util.ts
// instead, which strips line breaks and control characters.
//
// rsvpLink is server-built from FRONTEND_BASE_URL (env config) and a
// crypto.randomBytes(32) hex token (invite.repository.ts), never user input.
export const buildInviteRsvpLink = (token: string): string => frontendUrl(`/rsvp?token=${token}`);

// ─────────────────────────────────────────
//  WHEN AND WHERE — per guest, from THEIR invited days
//
//  The venue belongs to each event day, and a guest may be invited to a
//  subset of an event's days, so the "when and where" of an invitation or
//  reminder is built per guest from their own days (invite-dispatch.service.ts
//  passes them in, archived days already excluded, earliest first):
//    - each invited day → its date and time, its venue name, its address;
//      headed by the day's label when there are several
//    - none (defensive: every invite is created with at least one day, but
//      its only day could since have been archived) → the event's earliest
//      date, if there is one, and no venue rather than a wrong one.
// ─────────────────────────────────────────
export interface InviteDayLine {
  label: string;
  date: Date;
  startTime?: Date | null;
  endTime?: Date | null;
  location: string | null;
  address: string | null;
}

const whenText = (day: InviteDayLine): string => {
  const start = day.startTime ? formatGuestTime(day.startTime) : null;
  const end = day.endTime ? formatGuestTime(day.endTime) : null;
  const time = start && end ? `${start} – ${end}` : start;
  return time ? `${formatGuestDate(day.date)} · ${time}` : formatGuestDate(day.date);
};

const dayGroups = (days: InviteDayLine[], fallbackDateLabel: string | null) => {
  if (days.length === 0) {
    return fallbackDateLabel ? [{ heading: null, lines: [fallbackDateLabel] }] : [];
  }
  return days.map((day) => ({
    heading: days.length > 1 ? day.label.trim() : null,
    lines: [whenText(day), day.location?.trim(), day.address?.trim()].filter((l): l is string => !!l),
  }));
};

// ─────────────────────────────────────────
//  THE INVITATION DESIGN IN THE EMAIL
//
//  Only an UPLOAD design is shown (a TEMPLATE is drawn by the frontend and
//  has no image to send). The stored imageUrl is a Cloudinary delivery URL
//  already checked by invitation-design-validation.util.ts; it is rewritten
//  to an explicit JPEG, 1200px wide (2x for the 600px column), never
//  upscaled. Never f_auto: email image proxies (Gmail's especially) fetch
//  with their own Accept header and get a format the reader may not show.
//  A URL not in the expected shape is left out rather than sent as is.
// ─────────────────────────────────────────
export interface InviteEmailDesign {
  kind: InvitationDesignKind;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
}

export const EMAIL_DESIGN_TRANSFORM = 'f_jpg,w_1200,c_limit';

const CLOUDINARY_IMAGE_UPLOAD = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/;

export const emailDesignImageUrl = (imageUrl: string): string | null => {
  const match = CLOUDINARY_IMAGE_UPLOAD.exec(imageUrl);
  return match ? `${match[1]}${EMAIL_DESIGN_TRANSFORM}/${match[2]}` : null;
};

const designBlock = (design: InviteEmailDesign | null, eventName: string): EmailBlock[] => {
  if (design?.kind !== 'UPLOAD' || !design.imageUrl) return [];
  const src = emailDesignImageUrl(design.imageUrl);
  if (!src) return [];
  return [{ kind: 'image', src, alt: design.altText?.trim() || `Invitation to ${eventName}`, width: design.width, height: design.height }];
};

// ─────────────────────────────────────────
//  INVITATIONS AND REMINDERS
//
//  The guest should feel they got an e-velope: the seal, "You've received
//  an e-velope", the event name, their days, and one button. A reminder is
//  the same email, gentler, with the reply deadline when there is one.
//  Never "RSVP" in a subject line.
//
//  From:     "<host name> via e-velope" <RESEND_INVITE_EMAIL>
//  Reply-To: the organiser who created the event, so a reply reaches a person
// ─────────────────────────────────────────
export interface InviteEmailInput {
  eventName: string;
  // Event.hostName; the event name stands in when there is none.
  hostName: string | null;
  days: InviteDayLine[];
  fallbackDateLabel: string | null;
  rsvpDeadline: Date | null;
  rsvpLink: string;
  design: InviteEmailDesign | null;
  organiserEmail: string | null;
}

export type BuiltEmail = Omit<OutgoingEmail, 'to'>;

const senderFor = (input: InviteEmailInput): string =>
  sanitizeDisplayName(input.hostName?.trim() || input.eventName);

export const buildInviteFromHeader = (input: InviteEmailInput): string =>
  formatFromHeader(`${senderFor(input)} via e-velope`, inviteSenderAddress());

const preheaderFor = (input: InviteEmailInput): string => {
  const first = input.days[0];
  const parts = first
    ? [input.eventName, formatGuestDate(first.date), first.location?.trim()]
    : [input.eventName, input.fallbackDateLabel];
  return parts.filter((p): p is string => !!p).join(' · ');
};

const hostLine = (input: InviteEmailInput): EmailBlock[] =>
  input.hostName?.trim() ? [{ kind: 'paragraph', text: `From ${input.hostName.trim()}`, muted: true }] : [];

const guestReason = (input: InviteEmailInput): string =>
  `You received this because ${senderFor(input)} added you to their guest list.`;

const buildGuestEmail = (input: InviteEmailInput, subject: string, eyebrow: string, extra: EmailBlock[]): BuiltEmail => {
  const blocks: EmailBlock[] = [
    { kind: 'seal' },
    { kind: 'eyebrow', text: eyebrow },
    { kind: 'title', text: input.eventName },
    ...hostLine(input),
    ...designBlock(input.design, input.eventName),
    ...extra,
    { kind: 'details', groups: dayGroups(input.days, input.fallbackDateLabel) },
    { kind: 'button', label: 'Open your e-velope', href: input.rsvpLink },
  ];
  const { html, text } = renderEmail({ subject, preheader: preheaderFor(input), blocks, reason: guestReason(input) });
  return {
    from: buildInviteFromHeader(input),
    ...(input.organiserEmail ? { replyTo: input.organiserEmail } : {}),
    subject,
    html,
    text,
  };
};

export const buildInviteEmailSubject = (input: InviteEmailInput): string =>
  `You've received an e-velope from ${sanitizeHeaderText(senderFor(input))}`;

export const buildReminderEmailSubject = (input: InviteEmailInput): string =>
  `Your e-velope from ${sanitizeHeaderText(senderFor(input))} is waiting`;

export const buildInviteEmail = (input: InviteEmailInput): BuiltEmail =>
  buildGuestEmail(input, buildInviteEmailSubject(input), "You've received an e-velope", []);

export const buildReminderEmail = (input: InviteEmailInput): BuiltEmail =>
  buildGuestEmail(input, buildReminderEmailSubject(input), 'Your e-velope is still waiting for a reply', [
    {
      kind: 'paragraph',
      text: input.rsvpDeadline
        ? `Replies close on ${formatGuestDate(input.rsvpDeadline)}.`
        : 'Open it whenever you’re ready to let your host know whether you can make it.',
    },
  ]);

export const buildInviteSmsBody = (eventName: string, rsvpLink: string): string =>
  `You're invited to ${eventName}! RSVP: ${rsvpLink}`;

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
