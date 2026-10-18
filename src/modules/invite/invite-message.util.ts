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

// Who a guest email is from: the host, else the event name.
type SenderSource = Pick<InviteEmailInput, 'eventName' | 'hostName'>;

const senderFor = (input: SenderSource): string =>
  sanitizeDisplayName(input.hostName?.trim() || input.eventName);

export const buildInviteFromHeader = (input: SenderSource): string =>
  formatFromHeader(`${senderFor(input)} via e-velope`, inviteSenderAddress());

const preheaderFor = (input: InviteEmailInput): string => {
  const first = input.days[0];
  const parts = first
    ? [input.eventName, formatGuestDate(first.date), first.location?.trim()]
    : [input.eventName, input.fallbackDateLabel];
  return parts.filter((p): p is string => !!p).join(' · ');
};

const hostLine = (input: SenderSource): EmailBlock[] =>
  input.hostName?.trim() ? [{ kind: 'paragraph', text: `From ${input.hostName.trim()}`, muted: true }] : [];

const guestReason = (input: SenderSource): string =>
  `You received this because ${senderFor(input)} added you to their guest list.`;

const registrantReason = (input: SenderSource): string =>
  `You received this because you registered for ${sanitizeHeaderText(input.eventName)} on e-velope.`;

const buildGuestEmail = (
  input: InviteEmailInput,
  subject: string,
  eyebrow: string,
  extra: EmailBlock[],
  reason: string = guestReason(input)
): BuiltEmail => {
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
  const { html, text } = renderEmail({ subject, preheader: preheaderFor(input), blocks, reason });
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

// ─────────────────────────────────────────
//  PUBLIC SELF-REGISTRATION
//
//  Sent when someone registers through a public event's link, and again
//  when the same email registers a second time (event-public.service.ts):
//  the same guest email as an invitation (seal, event, the days they said
//  they'll attend, one "Open your e-velope" button to their own invite),
//  so they can change their answer later like any guest. Same From and
//  Reply-To as an invitation; the footer says they registered themselves.
// ─────────────────────────────────────────
export const buildRegistrationEmailSubject = (input: InviteEmailInput): string =>
  `You're registered for ${sanitizeHeaderText(input.eventName)}`;

export const buildRegistrationEmail = (input: InviteEmailInput): BuiltEmail =>
  buildGuestEmail(
    input,
    buildRegistrationEmailSubject(input),
    "You're registered",
    [{ kind: 'paragraph', text: 'Open your e-velope any time to change your answer.' }],
    registrantReason(input)
  );

// The same email registering again (event-public.service.ts): their own
// link once more, said plainly as a re-send. The page answered exactly as
// it does for a new registration, so this email is the only place that
// says they were already registered, and only its owner reads it. Someone
// else may have typed their address, so it says nothing changed.
export const buildRegistrationResendEmailSubject = (input: InviteEmailInput): string =>
  `Your link for ${sanitizeHeaderText(input.eventName)}`;

export const buildRegistrationResendEmail = (input: InviteEmailInput): BuiltEmail =>
  buildGuestEmail(
    input,
    buildRegistrationResendEmailSubject(input),
    "Here's your link again",
    [
      {
        kind: 'paragraph',
        text:
          "You're already registered, and your email address was entered on the registration page again, so here is your e-velope. " +
          'Open it any time to change your answer. If that wasn’t you, you can ignore this email: nothing has changed.',
      },
    ],
    registrantReason(input)
  );

// ─────────────────────────────────────────
//  ANNOUNCEMENTS AND THE CANCELLATION EMAIL
//
//  Guest emails like an invitation: the same From ("<host> via e-velope")
//  and Reply-To (resolveReplyTo), the same layout. An announcement is the
//  organiser's subject as given and their body as plain text (the layout's
//  `message` block escapes it and keeps its line breaks), then the one
//  "Open your e-velope" button to that guest's own invitation. The
//  cancellation email has no seal and no button: there's nothing left to
//  reply to. It names the event and its dates, and the organiser's note
//  when there is one.
// ─────────────────────────────────────────
export interface GuestMessageInput {
  eventName: string;
  hostName: string | null;
  organiserEmail: string | null;
  // A guest who registered themselves gets the registration footer line.
  selfRegistered: boolean;
}

export interface AnnouncementEmailInput extends GuestMessageInput {
  subject: string;
  body: string;
  rsvpLink: string;
}

export interface CancellationEmailInput extends GuestMessageInput {
  // The event's live days, earliest first.
  days: InviteDayLine[];
  note: string | null;
}

const PREHEADER_LENGTH = 110;

const firstLine = (text: string): string => {
  const line = text.split(/\r\n?|\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > PREHEADER_LENGTH ? `${line.slice(0, PREHEADER_LENGTH - 1).trimEnd()}…` : line;
};

const guestMessageEmail = (input: GuestMessageInput, subject: string, preheader: string, blocks: EmailBlock[]): BuiltEmail => {
  const reason = input.selfRegistered ? registrantReason(input) : guestReason(input);
  const { html, text } = renderEmail({ subject, preheader, blocks, reason });
  return {
    from: buildInviteFromHeader(input),
    ...(input.organiserEmail ? { replyTo: input.organiserEmail } : {}),
    subject,
    html,
    text,
  };
};

export const buildAnnouncementEmail = (input: AnnouncementEmailInput): BuiltEmail => {
  const host = input.hostName?.trim();
  return guestMessageEmail(input, sanitizeHeaderText(input.subject), firstLine(input.body) || input.eventName, [
    { kind: 'seal' },
    { kind: 'eyebrow', text: host ? `A message from ${host}` : 'A message about your e-velope' },
    { kind: 'title', text: input.eventName },
    { kind: 'message', text: input.body },
    { kind: 'button', label: 'Open your e-velope', href: input.rsvpLink },
  ]);
};

export const buildCancellationEmailSubject = (eventName: string): string =>
  `${sanitizeHeaderText(eventName)} has been cancelled`;

export const buildCancellationEmail = (input: CancellationEmailInput): BuiltEmail => {
  const dates = input.days.map((day) => ({
    heading: input.days.length > 1 ? day.label.trim() : null,
    lines: [whenText(day)],
  }));
  const first = input.days[0];
  const note = input.note?.trim();
  return guestMessageEmail(
    input,
    buildCancellationEmailSubject(input.eventName),
    [`${input.eventName} has been cancelled`, first ? formatGuestDate(first.date) : null].filter(Boolean).join(' · '),
    [
      { kind: 'eyebrow', text: 'This event has been cancelled' },
      { kind: 'title', text: input.eventName },
      ...hostLine(input),
      ...(dates.length ? [{ kind: 'details' as const, groups: dates }] : []),
      ...(note
        ? [
            { kind: 'paragraph' as const, text: `A note from ${senderFor(input)}:`, muted: true },
            { kind: 'message' as const, text: note },
          ]
        : []),
      {
        kind: 'paragraph',
        text: input.organiserEmail
          ? 'There’s nothing you need to do. If you have a question, reply to this email.'
          : 'There’s nothing you need to do.',
        muted: true,
      },
    ]
  );
};

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
