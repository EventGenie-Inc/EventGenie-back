import { type EventStatus, type RsvpFieldType } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { ticketPurchaseService, type ReservedPurchase } from '../ticket-purchase/ticket-purchase.service.js';
import { type SubmitRsvpDto, type QuoteTicketDto } from './rsvp.types.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import {
  normalizeEmail,
  assertValidEmail,
  normalizePhoneToE164,
  isValidEmail,
  isInternationalPhoneNumber,
  CONTACT_ERROR_CODES,
  PHONE_FORMAT_MESSAGE,
  GUEST_EMAIL_REQUIRED_MESSAGE,
  CONTACT_EMAIL_UNAVAILABLE_MESSAGE,
} from '../guest/guest-validation.util.js';
import { guestRepository } from '../guest/guest.repository.js';
import { centsToDecimalString } from '../../shared/payments/money.util.js';
import { toGuestDesign } from '../invitation-design/invitation-design-guest.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { toDayVenueView } from '../event-day/event-day-venue.util.js';
import { eventPublicRepository } from '../event-public/event-public.repository.js';
import {
  REGISTRATION_ERROR_CODES,
  isEmailInAllowedDomains,
  emailDomainRefusal,
} from '../event-public/registration-rules.util.js';

// A guest has no account, no support channel, and no context beyond the
// one link they clicked — every message in this file is written for
// that reader specifically: what happened, and what they can do about
// it. Never leak tenant names, internal ids, guest counts, or anything
// about other guests; a guest's token only entitles them to know about
// their own invite.

// Guest-facing wording for the same three blocked statuses invites use
// (COMPLETED/CANCELLED read fine to a guest as-is); DRAFT gets its own
// text since "publish it before sending invitations" is organiser
// language a guest should never see. In practice a guest can only ever
// hold a token for an event that WAS published (invites can't be sent
// to a draft event — Task 3), so this branch is defensive, not reachable.
export const RSVP_BLOCK_MESSAGES: Partial<Record<EventStatus, string>> = {
  DRAFT: 'This event is not yet open for RSVPs.',
  COMPLETED: 'This event has already taken place.',
  CANCELLED: 'This event has been cancelled.',
};

// 403 — the guest is correctly identified (their token is valid), but
// the event's current state means RSVPs aren't accepted right now. Not
// a 409: nothing about THIS submission conflicts with anything; the
// door is simply closed regardless of what they submit.
const assertEventAcceptsRsvp = (effectiveStatus: EventStatus): void => {
  if (effectiveStatus === 'PUBLISHED') return;
  throw new HttpError(403, RSVP_BLOCK_MESSAGES[effectiveStatus] ?? 'This event is not currently accepting RSVPs.');
};

// rsvpDeadline is independent of Event.status (Batch A Task 1) — an event
// can be perfectly PUBLISHED and still have RSVP submission closed. Only
// guest self-service is affected; organiser guest management in
// guest.service.ts never checks this.
const isRsvpDeadlinePassed = (rsvpDeadline: Date | null): boolean =>
  !!rsvpDeadline && rsvpDeadline < new Date();

// 410 Gone, not 403 — the ability to RSVP genuinely existed and is now
// permanently gone as of a known point in time; that's precisely what
// Gone means, and it's a more specific signal to a frontend than the
// generic "not accepting RSVPs" 403 above. Same reasoning is applied
// below to an expired invite token.
//
// This is now the ONLY gate distinguishing "still open" from "closed" —
// a guest may resubmit (edit) their response as many times as they like
// up to this point, and an event with no deadline stays editable until
// assertEventAcceptsRsvp's own status check closes it at COMPLETED.
// `isEdit` only changes the wording: a guest editing an existing answer
// is told their existing response stands, not urged to "still RSVP".
const assertRsvpDeadlineNotPassed = (rsvpDeadline: Date | null, isEdit: boolean): void => {
  if (isRsvpDeadlinePassed(rsvpDeadline)) {
    const deadlineText = formatGuestDate(rsvpDeadline as Date);
    throw new HttpError(
      410,
      isEdit
        ? `Responses for this event closed on ${deadlineText}. Your existing response stands — contact the organiser if you need to change it.`
        : `Responses for this event closed on ${deadlineText}. Contact the organiser if you still need to RSVP.`
    );
  }
};

// Guest RSVP submissions are the first writes in this codebase performed by
// a non-platform actor. Invite.updatedBy is a plain String (not an FK to
// User), so this sentinel documents the convention for guest-originated writes.
const GUEST_ACTOR = 'guest-rsvp';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isValidRsvpResponseShape = (value: unknown): value is { rsvpFieldId: string; value: string } =>
  typeof value === 'object' &&
  value !== null &&
  isNonEmptyString((value as Record<string, unknown>)['rsvpFieldId']) &&
  typeof (value as Record<string, unknown>)['value'] === 'string';

// No domain concept of "party size" exists yet — an Invite is 1:1 with a
// guest, and ticketing has no payment integration to derive a real limit
// from. 10 is a generous cap for one guest buying on behalf of their
// household while still bounding how much of a small venue's stock a
// single submission can claim; it's a sanity ceiling independent of (and
// in addition to) the per-ticket totalQuantity check further down.
const MAX_TICKET_QUANTITY = 10;

const assertValidTicketQuote = (data: QuoteTicketDto): void => {
  if (!isNonEmptyString(data.token)) {
    throw new HttpError(400, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
  }
  if (!isNonEmptyString(data.ticketId)) {
    throw new HttpError(400, "The selected ticket isn't valid. Please refresh the page and try again.");
  }
  if (!isPositiveInteger(data.quantity) || data.quantity > MAX_TICKET_QUANTITY) {
    throw new HttpError(400, `Ticket quantity must be a whole number between 1 and ${MAX_TICKET_QUANTITY}.`);
  }
};

// A single guard for the whole payload, run once before the transaction
// opens — every field below arrives straight from an unauthenticated
// POST body, so a malformed shape anywhere must be rejected before any
// database work begins, not discovered piecemeal at each field's point
// of use (which is how `token` alone reaching tx.invite.findUnique as
// `undefined` used to raise a raw Prisma validation error — a 500 that,
// in development, dumps the Invite model schema to an anonymous caller;
// same fix as memory-hub.service.ts's guest upload path). This checks
// SHAPE only — whether an id actually belongs to THIS invite's event
// (rsvpFieldId, ticketId, day ids) can only be checked once the invite
// is loaded, same as the existing ticket/day-id re-validation below.
const assertValidSubmission = (data: SubmitRsvpDto): void => {
  if (!isNonEmptyString(data.token)) {
    throw new HttpError(400, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
  }

  if (data.attendingDayIds !== undefined && (!Array.isArray(data.attendingDayIds) || !data.attendingDayIds.every(isNonEmptyString))) {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }

  if (data.rsvpResponses !== undefined && (!Array.isArray(data.rsvpResponses) || !data.rsvpResponses.every(isValidRsvpResponseShape))) {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }

  if (data.plusOneNames !== undefined && (!Array.isArray(data.plusOneNames) || !data.plusOneNames.every(isNonEmptyString))) {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }

  if (data.ticketId !== undefined && !isNonEmptyString(data.ticketId)) {
    throw new HttpError(400, "The selected ticket isn't valid. Please refresh the page and try again.");
  }

  // Bounded before any arithmetic touches it — an unvalidated ticketQuantity
  // used to coerce in `soldCount + quantity`, silently defeating the
  // totalQuantity check below (a stock-limit bypass), then reach Prisma as
  // NaN/a string and raise the same class of schema-leaking error as token.
  if (data.ticketQuantity !== undefined && (!isPositiveInteger(data.ticketQuantity) || data.ticketQuantity > MAX_TICKET_QUANTITY)) {
    throw new HttpError(400, `Ticket quantity must be a whole number between 1 and ${MAX_TICKET_QUANTITY}.`);
  }

  if (data.paymentRef !== undefined && typeof data.paymentRef !== 'string') {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }

  if (data.firstName !== undefined && typeof data.firstName !== 'string') {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }

  if (data.surname !== undefined && typeof data.surname !== 'string') {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }

  // Required: an absent/non-boolean `attending` used to be read as a
  // decline, silently recording an answer the guest never gave.
  if (typeof data.attending !== 'boolean') {
    throw new HttpError(422, "Please let us know whether you'll be attending.");
  }

  // null is meaningful here (remove this contact), so only other non-strings are malformed.
  if (data.email !== undefined && data.email !== null && typeof data.email !== 'string') {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }

  if (data.phoneNumber !== undefined && data.phoneNumber !== null && typeof data.phoneNumber !== 'string') {
    throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
  }
};

// undefined (field omitted) and '' (submitted blank) both mean "leave
// existing data alone" — a guest resubmitting a form that only shows
// SOME fields (e.g. a plain "attending?" toggle with no name field at
// all) must never be treated as clearing what an earlier submission, or
// the organiser, already set. Only a genuinely non-empty value is ever
// written.
// A guest's intent for one contact field on submit: keep what's stored
// (omitted or blank — the long-standing "blank never erases" rule, which the
// frontend relies on for fields it doesn't show), remove it (explicit null),
// or set it.
type ContactIntent = { kind: 'keep' } | { kind: 'remove' } | { kind: 'set'; value: string };

const contactIntent = (value: string | null | undefined): ContactIntent => {
  if (value === null) return { kind: 'remove' };
  const trimmed = trimToUndefined(value);
  return trimmed === undefined ? { kind: 'keep' } : { kind: 'set', value: trimmed };
};

// The guest-import validators (guest-validation.util.ts) throw 400 — right
// for an organiser's spreadsheet row, which is malformed input. On the RSVP
// form it is a well-formed answer that fails a precondition, so the same
// specific message ("'0821234567' is missing a country code, use
// +27821234567") is re-raised as 422, its machine-readable code kept. The
// normalisation itself is exactly guest import's: same functions, same
// default country (ZA).
const asUnprocessable = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 400) throw new HttpError(422, err.message, err.code);
    throw err;
  }
};

// A plain decimal number, as a guest types one: "12", "-3", "2.5". Not
// Number()'s looser idea of a number ("0x1f", "1e3", "Infinity").
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

// The message for an answer that isn't its question's type, or null.
// Only EMAIL, PHONE and NUMBER have a format; every other type takes any text.
const customAnswerProblem = (fieldType: RsvpFieldType, label: string, value: string): string | null => {
  const answer = typeof value === 'string' ? value.trim() : '';
  if (!answer) return null;
  switch (fieldType) {
    case 'EMAIL':
      return isValidEmail(answer) ? null : `Enter an email address like name@example.com for '${label}'.`;
    case 'PHONE':
      return isInternationalPhoneNumber(answer) ? null : `${PHONE_FORMAT_MESSAGE} for '${label}'.`;
    case 'NUMBER':
      return PLAIN_NUMBER.test(answer) ? null : `Enter a number for '${label}'.`;
    default:
      return null;
  }
};

const trimToUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const rsvpService = {

  quoteTicket: async (data: QuoteTicketDto) => {
    assertValidTicketQuote(data);
    const invite = await inviteRepository.findByToken(data.token);
    if (!invite) {
      throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      throw new HttpError(410, `This invitation link expired on ${formatGuestDate(invite.expiresAt)}. Contact the organiser for a new one.`);
    }
    assertEventAcceptsRsvp(resolveEffectiveStatus(invite.event));
    assertRsvpDeadlineNotPassed(invite.event.rsvpDeadline, invite.used);

    const ticket = invite.event.tickets.find((candidate) => candidate.id === data.ticketId);
    if (!ticket) {
      throw new HttpError(404, 'This ticket type is no longer available.');
    }
    return ticketPurchaseService.quote(ticket, data.quantity);
  },

  // Public, unauthenticated read — returns flags rather than throwing on
  // invalid state, since the caller is a guest's browser rendering a form.
  validate: async (token: string) => {
    const invite = await inviteRepository.findByToken(token);
    // The one genuinely error-throwing case left in this method — with no
    // invite at all there's no record to hang isExpired/isUsed/etc. flags
    // off, so unlike those, this can't be turned into a flag.
    if (!invite) {
      throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }

    const isExpired = !!invite.expiresAt && invite.expiresAt < new Date();
    // Switched-off features reach the guest as if the event never had
    // them: no tickets offered (a free event, no ticket list, no purchase
    // to retry) and no design. What is saved stays saved; it is only not
    // shown.
    const ticketingOn = isFeatureEnabled('ticketing');
    const ticketPurchase = ticketingOn ? (invite.ticketPurchases[0] ?? null) : null;
    // Earliest first, so "the first invited day" (whose venue fills the
    // compatibility fields on `event` below) is well defined.
    const invitedDays = invite.inviteEventDay
      .map((d) => d.eventDay)
      .slice()
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const firstDayVenue = invitedDays[0] ? toDayVenueView(invitedDays[0]) : { location: null, address: null, latitude: null, longitude: null };

    return {
      // Deliberate, hand-picked projection — a guest sees an invitation,
      // not a database row. Mirrors event-public.service.ts's
      // toPublicView: no tenantId, no createdByUserId/createdBy/updatedBy,
      // no coverImagePublicId, no shareToken, no internal counters
      // (Ticket.soldCount). Built as an explicit allowlist (not a spread
      // of the Prisma row) so this can never silently start leaking a
      // field added to Invite/Event/Guest/Ticket later.
      invite: {
        // The invite's own credential — already known to this caller (it's
        // how they reached this response), and submit()/reloadAfterDeadline
        // on the frontend resend it, so it stays in the payload.
        token: invite.token,
        status: invite.status,
        expiresAt: invite.expiresAt,
        guest: {
          firstName: invite.guest.firstName,
          surname: invite.guest.surname,
          email: invite.guest.email,
          phoneNumber: invite.guest.phoneNumber,
          plusOnesAllowed: invite.guest.plusOnesAllowed,
        },
        // The days THIS invite offers — never every EventDay on the
        // event (a guest may be invited to a subset).
        // Each day carries its own venue — the venue belongs to the day.
        inviteEventDay: invitedDays.map((day) => ({
          eventDay: {
            id: day.id,
            label: day.label,
            date: day.date,
            startTime: day.startTime,
            endTime: day.endTime,
            ...toDayVenueView(day),
          },
        })),
        event: {
          name: invite.event.name,
          description: invite.event.description,
          hostName: invite.event.hostName,
          // DEPRECATED — rollout compatibility only. The venue belongs to
          // each day (inviteEventDay[].eventDay above); these four keys
          // are NOT the retired Event columns but a copy of this guest's
          // FIRST invited day's venue, so the frontend deployed before the
          // change keeps showing a correct venue. Remove them together
          // with the Event venue columns (STEERING Known gaps).
          location: firstDayVenue.location,
          address: firstDayVenue.address,
          latitude: firstDayVenue.latitude,
          longitude: firstDayVenue.longitude,
          coverImageUrl: invite.event.coverImageUrl,
          rsvpDeadline: invite.event.rsvpDeadline,
          // Reported as the EFFECTIVE status, consistent with every other
          // read path — the guest's browser branches on this to decide
          // whether to render the RSVP form at all.
          status: resolveEffectiveStatus(invite.event),
          ticketing: ticketingOn ? invite.event.ticketing : 'FREE',
          // Deliberately added to this explicit allowlist, not a spread —
          // see this projection's own header comment. Informational only
          // (schema.prisma's comment on Event.ticketsRefundable), but
          // must reach the guest BEFORE they pay: someone should know
          // what they're agreeing to at the point of purchase, not
          // discover it afterwards. Meaningless while ticketing is FREE;
          // sent regardless since it costs nothing and keeps this
          // projection simple.
          ticketsRefundable: invite.event.ticketsRefundable,
          rsvpFields: invite.event.rsvpFields.map((f) => ({
            id: f.id,
            label: f.label,
            fieldType: f.fieldType,
            isRequired: f.isRequired,
            options: f.options,
          })),
          // Only non-archived, isAvailable tickets — see
          // invite.repository.ts's findByToken.
          tickets: (ticketingOn ? invite.event.tickets : []).map((t) => ({
            id: t.id,
            name: t.name,
            price: t.price,
            currency: t.currency,
          })),
        },
      },
      // The invitation card's design: null, a template + overrides, or an
      // uploaded image. Guest-safe projection (toGuestDesign): no ids,
      // audit fields or Cloudinary publicId.
      design: isFeatureEnabled('invitationDesigns') ? toGuestDesign(invite.event.invitationDesigns[0]) : null,
      isExpired,
      isUsed: invite.used,
      // Flag, not a throw — same "return flags, don't throw" design as
      // isExpired/isUsed above, so the frontend can render "Responses
      // closed" instead of the form.
      isRsvpDeadlinePassed: isRsvpDeadlinePassed(invite.event.rsvpDeadline),
      // Added for the edit form to prefill from — a guest revisiting
      // their link (isUsed: true, deadline not passed) needs to see what
      // they said last time, not a blank form. Additive only; nothing
      // above this line changed shape.
      // Only days still on the invitation: a prefilled answer for an
      // archived (hidden) day would ride along on the guest's next submit
      // and be refused there.
      attendingDayIds: invite.attendances
        .map((a) => a.eventDayId)
        .filter((id) => invite.inviteEventDay.some((d) => d.eventDayId === id)),
      rsvpResponses: invite.rsvpResponses.map((r) => ({ rsvpFieldId: r.rsvpFieldId, value: r.value })),
      plusOneNames: invite.guest.plusOnes.map((p) => p.firstName),
      ticketPurchase: ticketPurchase
        ? {
            ticketId: ticketPurchase.ticketId,
            quantity: ticketPurchase.quantity,
            totalPaid: ticketPurchase.totalPaid,
            currency: ticketPurchase.currency,
            // PENDING/PAID/FAILED/EXPIRED — lets the guest's browser
            // show "confirming your payment" / "paid" / "try again"
            // instead of assuming existence-of-a-row means paid, which
            // was true before Ticketing & Payments and no longer is.
            status: ticketPurchase.status,
          }
        : null,
    };
  },

  submit: async (data: SubmitRsvpDto) => {
    assertValidSubmission(data);
    // validate() offers no tickets while ticketing is off, so only a stale
    // or hand-made request gets here; it is refused, not quietly dropped.
    if (data.ticketId && !isFeatureEnabled('ticketing')) {
      throw new HttpError(422, "Tickets aren't available for this event. Please refresh the page and reply again.");
    }

    const result = await prisma.$transaction(async (tx) => {
      // Every lookup a later step could need is folded into this ONE
      // query — existing plus-ones (with their invite ids, for archiving)
      // and any existing ticket purchase included right here — rather
      // than a separate round trip per lookup. Each `await` inside an
      // interactive transaction is a full network round trip to Neon,
      // measured in testing at ~300-500ms; a handful of "just one more
      // lookup" calls is exactly what re-introduces the timeout this
      // whole file exists to avoid, even after every WRITE is batched.
      const invite = await tx.invite.findUnique({
        where: { token: data.token },
        include: {
          guest: {
            include: {
              plusOnes: {
                where: { isArchived: false },
                include: { invites: { where: { isArchived: false }, select: { id: true } } },
              },
            },
          },
          inviteEventDay: true,
          ticketPurchases: true,
          event: {
            include: {
              tickets: true,
              eventDays: { where: { isArchived: false } },
              rsvpFields: { where: { isArchived: false } },
            },
          },
        },
      });

      if (!invite) {
        throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
      }
      // 410 — same reasoning as the RSVP-deadline case below: this
      // specific link had a lifespan and it has passed, distinct from
      // "not accepting RSVPs right now" (403) or "closed" (410, deadline).
      // Applies uniformly to a first submission and an edit — an
      // organiser-set expiry on the invite itself is a harder outer bound
      // than the event-wide RSVP deadline, and nothing below relaxes it.
      if (invite.expiresAt && invite.expiresAt < new Date()) {
        throw new HttpError(410, `This invitation link expired on ${formatGuestDate(invite.expiresAt)}. Contact the organiser for a new one.`);
      }
      assertEventAcceptsRsvp(resolveEffectiveStatus(invite.event));
      // A guest may resubmit (edit) their response as many times as they
      // like up to the RSVP deadline — invite.used no longer blocks a
      // second submission by itself. `invite.used` (its value BEFORE this
      // submission) is what tells the deadline message whether to talk
      // about editing or about RSVPing for the first time, and is also
      // what gates the wholesale-clear step below (a first submission has
      // nothing to clear, so it skips straight past it).
      const isEdit = invite.used;
      assertRsvpDeadlineNotPassed(invite.event.rsvpDeadline, isEdit);

      // Guest-supplied name/contact — the whole reason firstName/surname
      // are nullable on Guest (schema.prisma) is that a phone-only import
      // has no name until the guest RSVPs and supplies one here. Computed
      // up front (before any other write) so a required-name rejection
      // fails BEFORE the wholesale-clear/attendance/plus-one writes below
      // start spending round trips, and so the one guest.update this adds
      // can carry every changed field in a single write.
      const nextFirstName = trimToUndefined(data.firstName);
      const nextSurname = trimToUndefined(data.surname);
      const emailIntent = contactIntent(data.email);
      const phoneIntent = contactIntent(data.phoneNumber);

      const guestUpdateData: { firstName?: string; surname?: string; email?: string | null; phoneNumber?: string | null } = {};

      if (nextFirstName !== undefined && nextFirstName !== invite.guest.firstName) {
        guestUpdateData.firstName = nextFirstName;
      }
      if (nextSurname !== undefined && nextSurname !== invite.guest.surname) {
        guestUpdateData.surname = nextSurname;
      }

      // Contact is a separate question from name: a guest imported by
      // phone has no email, and the reason BOTH fields exist on Guest is
      // so the other can be captured here — and so a guest whose number
      // changed can correct it. Unlike guest-validation.util.ts's
      // assertExactlyOneContact (which governs organiser create/update), a
      // guest is deliberately allowed to end up holding both.
      if (emailIntent.kind === 'set') {
        const normalizedEmail = normalizeEmail(emailIntent.value);
        asUnprocessable(() => assertValidEmail(normalizedEmail));
        if (normalizedEmail !== invite.guest.email) {
          // A public event's allowed domains hold at RSVP too, or a
          // registrant could register at the company address and then
          // swap it for any other. The same refusal registration gives;
          // the domains are on the public page, so it reveals nothing.
          // Only a change is checked: an address the guest already has
          // (from before the domains were set) never blocks a reply.
          if (
            invite.event.visibility === 'PUBLIC' &&
            !isEmailInAllowedDomains(normalizedEmail, invite.event.registrationEmailDomains)
          ) {
            throw emailDomainRefusal(invite.event.registrationEmailDomains);
          }
          guestUpdateData.email = normalizedEmail;
        }
      } else if (emailIntent.kind === 'remove' && invite.guest.email !== null) {
        guestUpdateData.email = null;
      }
      if (phoneIntent.kind === 'set') {
        const normalizedPhone = asUnprocessable(() => normalizePhoneToE164(phoneIntent.value));
        if (normalizedPhone !== invite.guest.phoneNumber) guestUpdateData.phoneNumber = normalizedPhone;
      } else if (phoneIntent.kind === 'remove' && invite.guest.phoneNumber !== null) {
        guestUpdateData.phoneNumber = null;
      }

      // A guest can never be left unreachable: the organiser's only way to
      // send them anything (invitation resend, reminder) is one of these.
      const finalEmail = guestUpdateData.email !== undefined ? guestUpdateData.email : invite.guest.email;
      const finalPhone = guestUpdateData.phoneNumber !== undefined ? guestUpdateData.phoneNumber : invite.guest.phoneNumber;
      // With sms off an email is the only way to reach a guest, so one who
      // has an email can't remove it (or swap it for a phone alone). A
      // guest who never had one isn't removing anything and can still reply.
      if (invite.guest.email && !finalEmail && !isFeatureEnabled('sms')) {
        throw new HttpError(422, GUEST_EMAIL_REQUIRED_MESSAGE, CONTACT_ERROR_CODES.EMAIL_REQUIRED);
      }
      if (!finalEmail && !finalPhone) {
        throw new HttpError(
          422,
          'Please keep at least one way for the organiser to reach you — an email address or a phone number.',
          CONTACT_ERROR_CODES.LAST_REMOVED
        );
      }

      // Future invitations and reminders go to the guest's CURRENT contact:
      // dispatch (invite-dispatch.service.ts's contactFor) reads the guest's
      // email/phone at send time on the invite's deliveryMethod channel. So
      // a changed number is picked up by itself; only a REMOVED channel
      // needs the invite moved to the one the guest kept.
      const nextDeliveryMethod =
        invite.deliveryMethod === 'SMS' && !finalPhone ? ('EMAIL' as const)
        : invite.deliveryMethod === 'EMAIL' && !finalEmail ? ('SMS' as const)
        : null;

      // An email another guest on the event already has can't be taken
      // (the same rule as organiser create and import). Refused with one
      // neutral message and code whatever the cause, so the answer never
      // says that another guest holds the address; how often one invite
      // can ask is bounded by rsvpSubmitInviteLimiter (STEERING "Guest
      // contact"). A phone is never checked: guests may share one.
      if (guestUpdateData.email && (await guestRepository.isEmailUsedByOtherGuest(invite.eventId, guestUpdateData.email, invite.guestId, tx))) {
        throw new HttpError(422, CONTACT_EMAIL_UNAVAILABLE_MESSAGE, CONTACT_ERROR_CODES.EMAIL_UNAVAILABLE);
      }

      // Required only when attending, and only when the guest has no name
      // at all yet — an organiser needs to know who's coming, and this is
      // the only moment a phone-only-imported guest is ever asked. A
      // decline needs no name (nothing to seat, nothing to check in), and
      // a guest who already has a name (organiser-entered or from an
      // earlier RSVP) is never re-prompted.
      const finalFirstName = guestUpdateData.firstName ?? invite.guest.firstName;
      if (data.attending && !finalFirstName) {
        throw new HttpError(422, "Please tell us your name so the organiser knows who's coming.");
      }

      // Custom questions the organiser marked required must be answered
      // when attending — the same rule the RSVP form applies client-side
      // (a decline needs no answers: nothing to cater for). Previously only
      // the frontend enforced it, so a direct call could skip them.
      if (data.attending) {
        const answered = new Set(
          (data.rsvpResponses ?? []).filter((r) => r.value.trim().length > 0).map((r) => r.rsvpFieldId)
        );
        const unanswered = invite.event.rsvpFields.filter((f) => f.isRequired && !answered.has(f.id));
        if (unanswered.length > 0) {
          throw new HttpError(
            422,
            `Please answer ${unanswered.map((f) => `'${f.label}'`).join(', ')} — the organiser needs ${unanswered.length === 1 ? 'this' : 'these'} to plan for you.`
          );
        }
      }

      // An answer to a typed question must be that type: EMAIL an email
      // address (guest import's pattern), PHONE an international number,
      // NUMBER a number. Checked attending or not, since answers are stored
      // either way; a blank answer is no answer, and required-ness is the
      // check above. Unknown field ids get their own 400 further down.
      for (const response of data.rsvpResponses ?? []) {
        const field = invite.event.rsvpFields.find((f) => f.id === response.rsvpFieldId);
        const message = field ? customAnswerProblem(field.fieldType, field.label, response.value) : null;
        if (message) throw new HttpError(422, message);
      }

      // A self-registered guest on an event with a registration cap can't
      // take more seats than are left: someone who registered alone and
      // later adds plus-ones, or who declined and now accepts, counts
      // against the cap exactly like a new registrant. Checked only when
      // the answer asks for MORE seats than they hold, so a guest already
      // over a cap the organiser lowered can still edit or decline.
      // Counted under the event's row lock, the same lock registration
      // takes, so the two can't race past the cap together.
      if (invite.guest.selfRegisteredAt && invite.event.registrationCap !== null) {
        const seatsHeld = invite.status !== 'DECLINED' ? 1 + invite.guest.plusOnes.length : 0;
        const seatsWanted = data.attending ? 1 + (data.plusOneNames?.length ?? 0) : 0;
        if (seatsWanted > seatsHeld) {
          await eventPublicRepository.lockEvent(tx, invite.eventId);
          const { registeredSeats } = await eventPublicRepository.countSeats(invite.eventId, tx);
          if (registeredSeats - seatsHeld + seatsWanted > invite.event.registrationCap) {
            throw new HttpError(
              409,
              seatsWanted > 1
                ? "This event is full, so there isn't room for your plus-ones. Please remove some and try again."
                : 'This event is full, so your answer can’t be changed to attending right now.',
              REGISTRATION_ERROR_CODES.FULL
            );
          }
        }
      }

      if (Object.keys(guestUpdateData).length > 0) {
        await tx.guest.update({ where: { id: invite.guestId }, data: guestUpdateData });
      }
      if (nextDeliveryMethod) {
        await tx.invite.update({ where: { id: invite.id }, data: { deliveryMethod: nextDeliveryMethod, updatedBy: GUEST_ACTOR } });
      }

      // Wholesale replace: an edit states the guest's CURRENT intent, not
      // an amendment to history, so whatever this invite (and any
      // plus-ones declared under it) had from an earlier submission is
      // cleared here before being rebuilt fresh below. Skipped entirely
      // on a first submission — nothing to clear, and skipping saves the
      // round trips on the common (first-time) case.
      //
      // Attendance and RsvpResponse have no soft-delete field at all
      // (fact records), so hard-deleting THIS invite's own rows is the
      // only option, not a judgment call. Guest/Invite DO soft-delete, so
      // a replaced plus-one is archived, not deleted — but its now-stale
      // Attendance/InviteEventDay rows are deliberately left in place
      // rather than also hard-deleted: they hang off an archived invite
      // that every live query (findAll, findByGuestIds,
      // countAcceptedInvitesForEvent, attendanceService's own lookups)
      // already excludes, so they're unreachable clutter, not a
      // correctness risk — and avoiding two more round trips per replaced
      // plus-one is exactly the kind of cost this rewrite exists to cut.
      if (isEdit) {
        await tx.attendance.deleteMany({ where: { inviteId: invite.id } });
        await tx.rsvpResponse.deleteMany({ where: { inviteId: invite.id } });

        if (invite.guest.plusOnes.length > 0) {
          const oldPlusOneInviteIds = invite.guest.plusOnes.flatMap((p) => p.invites.map((i) => i.id));
          const oldPlusOneGuestIds = invite.guest.plusOnes.map((p) => p.id);
          await tx.invite.updateMany({ where: { id: { in: oldPlusOneInviteIds } }, data: { isArchived: true } });
          await tx.guest.updateMany({ where: { id: { in: oldPlusOneGuestIds } }, data: { isArchived: true } });
        }
      }

      const attendances = [];
      if (data.attending) {
        const invitedDayIds = new Set(invite.inviteEventDay.map((d) => d.eventDayId));
        // event.eventDays is loaded with isArchived: false, so a day the
        // organiser archived after inviting this guest is missing here.
        const liveEventDayIds = new Set(invite.event.eventDays.map((d) => d.id));
        const attendingDayIds = data.attendingDayIds ?? [];

        for (const eventDayId of attendingDayIds) {
          if (invitedDayIds.has(eventDayId) && !liveEventDayIds.has(eventDayId)) {
            // 422 — a day this guest WAS invited to, since removed by the
            // organiser. Checked before the generic 400 below so the guest
            // is told what actually happened.
            throw new HttpError(422, "One of the days you selected is no longer part of this event. Please refresh the page and choose again.");
          }
          if (!invitedDayIds.has(eventDayId)) {
            // 400 — malformed submission: the day ids in `invitedDayIds`
            // are never guest-visible, so this can't name the offending
            // day without leaking an internal id; the guidance to
            // refresh covers the only two ways this happens (a stale
            // page, or a tampered request).
            throw new HttpError(400, "One of the days you selected isn't part of this invitation. Please refresh the page and try again.");
          }
        }

        // Needs the loaded guest (plusOnesAllowed), so this lives here
        // rather than in assertValidSubmission — same two-phase pattern as
        // the day-id check above. The allowance is the guest's OWN value,
        // not another guest's, so naming it in the message is safe.
        const plusOneNames = data.plusOneNames ?? [];
        if (plusOneNames.length > invite.guest.plusOnesAllowed) {
          throw new HttpError(
            400,
            `You can bring up to ${invite.guest.plusOnesAllowed} plus-one(s). Please remove some and try again.`
          );
        }

        // Batched — same fix as the plus-one section below and
        // bulkCreateWithInvites: a sequential per-day loop of individual
        // creates is what blew the interactive-transaction timeout in
        // testing. No read-back after the write either — createMany's
        // real ids/confirmedAt aren't needed by anything yet (no
        // frontend consumes this response today), and re-querying what
        // was just written is exactly the kind of extra round trip this
        // rewrite is cutting; {inviteId, eventDayId} is enough to say
        // which days were recorded.
        if (attendingDayIds.length > 0) {
          await tx.attendance.createMany({
            data: attendingDayIds.map((eventDayId) => ({ inviteId: invite.id, eventDayId })),
          });
          attendances.push(...attendingDayIds.map((eventDayId) => ({ inviteId: invite.id, eventDayId })));
        }

        // Each plus-one is a real Guest+Invite pair (mirrors
        // createWithInvite's shape) so check-in works with zero changes to
        // the attendance module — Attendance keys purely on inviteId, never
        // on Guest. The Invite is born already in its terminal state:
        // nobody will ever submit against its token, so there's no PENDING
        // phase to pass through. deliveryMethod is an inert placeholder —
        // never read, because every dispatch/resend/outstanding-invite
        // query excludes plus-ones via hostGuestId by construction.
        // A plus-one attends exactly the days their host attends (v1 has
        // no per-plus-one day selection) and captures name only — no
        // contact, no custom RSVP field answers (out of scope for v1).
        //
        // Batched via createMany (IDs pre-generated client-side), not a
        // per-name loop of individual creates — the same fix
        // bulkCreateWithInvites already applies to guest import, for the
        // same reason: a sequential-round-trip loop over a real (Neon)
        // connection blew the interactive-transaction timeout in testing
        // with as few as 2 plus-ones across 2 days.
        if (plusOneNames.length > 0) {
          const plusOneGuestIds = plusOneNames.map(() => crypto.randomUUID());
          const plusOneInviteIds = plusOneNames.map(() => crypto.randomUUID());

          await tx.guest.createMany({
            data: plusOneNames.map((name, i) => ({
              id: plusOneGuestIds[i]!,
              eventId: invite.eventId,
              firstName: name,
              surname: null,
              email: null,
              phoneNumber: null,
              hostGuestId: invite.guestId,
              plusOnesAllowed: 0,
              isArchived: false,
            })),
          });

          await tx.invite.createMany({
            data: plusOneNames.map((_, i) => ({
              id: plusOneInviteIds[i]!,
              eventId: invite.eventId,
              guestId: plusOneGuestIds[i]!,
              token: crypto.randomBytes(32).toString('hex'),
              status: 'ACCEPTED' as const,
              used: true,
              usedAt: new Date(),
              deliveryMethod: 'EMAIL' as const,
              expiresAt: null,
              isArchived: false,
              createdBy: GUEST_ACTOR,
              updatedBy: GUEST_ACTOR,
            })),
          });

          await tx.inviteEventDay.createMany({
            data: plusOneInviteIds.flatMap((inviteId) =>
              attendingDayIds.map((eventDayId) => ({ inviteId, eventDayId }))
            ),
          });

          const plusOneAttendanceRows = plusOneInviteIds.flatMap((inviteId) =>
            attendingDayIds.map((eventDayId) => ({ inviteId, eventDayId }))
          );
          await tx.attendance.createMany({ data: plusOneAttendanceRows });
          attendances.push(...plusOneAttendanceRows);
        }
      }

      const rsvpResponses = [];
      const submittedResponses = data.rsvpResponses ?? [];
      if (submittedResponses.length > 0) {
        const validFieldIds = new Set(invite.event.rsvpFields.map((f) => f.id));

        for (const response of submittedResponses) {
          if (!validFieldIds.has(response.rsvpFieldId)) {
            // 400 — same reasoning as the day-id check above: a well-shaped
            // but non-existent/wrong-event rsvpFieldId is a malformed
            // submission (stale page or tampered request), not something to
            // let fall through to a foreign-key violation at write time.
            throw new HttpError(400, "One of your answers isn't part of this invitation. Please refresh the page and try again.");
          }
        }

        // Batched, no read-back — same reasoning as the attendance
        // sections above.
        const responseRows = submittedResponses.map((response) => ({
          inviteId: invite.id,
          rsvpFieldId: response.rsvpFieldId,
          value: response.value,
        }));
        await tx.rsvpResponse.createMany({ data: responseRows });
        rsvpResponses.push(...responseRows);
      }

      // Paid-event decision: once a purchase exists for this invite, its
      // ticket/quantity are immutable through this edit flow — never
      // replaced, never deleted, regardless of whether it ended up PAID,
      // PENDING, FAILED, or EXPIRED. Changing ticket selection isn't
      // supported (contact the organiser); a resubmission that repeats
      // the SAME ticket/quantity is a no-op that returns the purchase
      // as-is — retrying or checking on its PAYMENT is a separate,
      // dedicated flow (rsvp.service.ts's retryTicketPayment /
      // confirmTicketPayment below), not something resubmitting the
      // whole RSVP form triggers. No separate lookup here —
      // `invite.ticketPurchases` already came back with the initial fetch.
      const existingPurchase = invite.ticketPurchases[0] ?? null;
      let ticketPurchase:
        | typeof existingPurchase
        | { id: string; ticketId: string; inviteId: string; quantity: number; totalPaid: string; currency: string; status: string } = existingPurchase;
      let freshReservation: ReservedPurchase | null = null;
      let guestEmailForReservation: string | null = null;

      if (data.ticketId && data.attending) {
        if (existingPurchase) {
          const requestedQuantity = data.ticketQuantity ?? 1;
          if (existingPurchase.ticketId !== data.ticketId || existingPurchase.quantity !== requestedQuantity) {
            throw new HttpError(
              409,
              "You've already started a ticket purchase for this event, and changing your ticket selection isn't supported yet. Contact the organiser to make changes."
            );
          }
          // Identical resubmission of what was already started/bought — no-op.
        } else {
          const ticket = invite.event.tickets.find((t) => t.id === data.ticketId);
          // 409 — a genuine state conflict: the ticket exists, but its
          // current state (archived / marked unavailable) conflicts with
          // trying to purchase it right now.
          if (!ticket || ticket.isArchived || !ticket.isAvailable) {
            throw new HttpError(409, 'This ticket type is no longer available. Please choose a different option or contact the organiser.');
          }

          const quantity = data.ticketQuantity ?? 1;

          // A ticket purchase needs somewhere to send the Paystack
          // checkout link and receipt — a guest imported by phone alone
          // has no email until they supply one, same moment as any
          // other contact-detail gap this form fills.
          guestEmailForReservation = finalEmail;
          if (!guestEmailForReservation) {
            throw new HttpError(400, 'An email address is required to purchase a ticket — please provide one above.');
          }

          // No totalQuantity/soldCount pre-check here — that would be
          // exactly the read-then-check-then-write race this design
          // exists to avoid. ticketPurchaseService.reserveWithinTransaction's
          // atomic guard (a single conditional UPDATE) is the real,
          // database-level check, and throws HttpError(409) itself if
          // there isn't room.
          freshReservation = await ticketPurchaseService.reserveWithinTransaction(tx, {
            tenantId: invite.event.tenantId,
            eventId: invite.eventId,
            inviteId: invite.id,
            ticket: { id: ticket.id, price: ticket.price, currency: ticket.currency },
            quantity,
          });

          ticketPurchase = {
            id: freshReservation.purchaseId,
            ticketId: ticket.id,
            inviteId: invite.id,
            quantity,
            // Same Decimal<->cents boundary as everywhere else in payments
            // code (money.util.ts) — freshReservation only carries cents.
            totalPaid: centsToDecimalString(freshReservation.totalChargeCents),
            currency: ticket.currency,
            status: 'PENDING',
          };
        }
      }

      // A guest declining while a PAID purchase stands is exactly the
      // case with no automated resolution — the RSVP change itself goes
      // through (their attendance/responses/plus-ones are already
      // cleared above), but the money doesn't move on its own. A
      // PENDING/FAILED/EXPIRED purchase isn't paid yet, so there's
      // nothing to refund-notice about — it simply lapses via its own
      // hold expiry if nobody ever completes it.
      const refundNotice = !data.attending && existingPurchase?.status === 'PAID'
        ? "You have a paid ticket for this event. Declining doesn't automatically refund it — contact the organiser directly about a refund."
        : null;

      const updatedInvite = await tx.invite.update({
        where: { id: invite.id },
        data: {
          used: true,
          usedAt: new Date(),
          status: data.attending ? 'ACCEPTED' : 'DECLINED',
          updatedBy: GUEST_ACTOR,
        },
      });

      return { invite: updatedInvite, attendances, rsvpResponses, ticketPurchase, refundNotice, freshReservation, guestEmailForReservation };
    }, {
      // Every write in this transaction is already batched to a FIXED
      // number of round trips regardless of day/field/plus-one count —
      // that part of the fix is real and stays. What's left is a
      // different problem: testing against the real (Neon) dev database
      // measured the first interactive transaction after a period of
      // inactivity taking 6-6.5s end-to-end — consistent with a
      // serverless Postgres connection's cold-start cost landing inside
      // the transaction window, not with round-trip count (a WARM
      // connection completed the same shape of transaction, editing 4
      // days/3 fields/2 plus-ones/a ticket purchase down to fewer of
      // each, well inside the default). Batching can't remove a one-time
      // connection cost that's paid regardless of how few queries follow
      // it, so raising the timeout here is the genuine fix for THIS
      // failure mode, not a substitute for the batching above — unlike
      // bulkCreateWithInvites's original timeout, which scaled with row
      // count and had no fixed floor to hit.
      timeout: 15000,
      // Added for Ticketing & Payments — maxWait (time allowed to
      // ACQUIRE a connection and START the transaction, distinct from
      // `timeout` above which bounds the transaction's own execution
      // once running) wasn't set here before, and Prisma's default
      // (~2s) is tuned for a warm pool. It didn't surface until this
      // batch's concurrency testing genuinely opened two simultaneous
      // interactive transactions against the same serverless
      // connection — P2028, "unable to start a transaction in the given
      // time" — which a single request never triggers. Two guests
      // racing for the last unit of a ticket is exactly the scenario
      // this whole file exists to get right, so this couldn't be left
      // as a latent gap.
      maxWait: 10000,
    });

    const { freshReservation, guestEmailForReservation, ...rest } = result;

    // Explicit guest-facing shape — never the raw Invite/TicketPurchase
    // rows the transaction above worked with. `rest.invite` is
    // tx.invite.update()'s full row (eventId, guestId, deliveryMethod,
    // editToken, createdBy/updatedBy, ...); `rest.ticketPurchase`, when it
    // reflects an EXISTING purchase (the no-op-resubmission branch above),
    // is the full TicketPurchase row (commissionCents, ticketPriceCents,
    // paymentRef — EventGenie's margin and a Paystack transaction id, never
    // guest-facing). attendances/rsvpResponses are already hand-built
    // {inviteId, ...} objects with nothing extra, same allowlist spirit as
    // validate()'s own projection above — kept as-is.
    const guestResult = {
      invite: {
        id: rest.invite.id,
        status: rest.invite.status,
        used: rest.invite.used,
        usedAt: rest.invite.usedAt,
      },
      attendances: rest.attendances,
      rsvpResponses: rest.rsvpResponses,
      ticketPurchase: rest.ticketPurchase
        ? {
            ticketId: rest.ticketPurchase.ticketId,
            quantity: rest.ticketPurchase.quantity,
            totalPaid: rest.ticketPurchase.totalPaid,
            currency: rest.ticketPurchase.currency,
            status: rest.ticketPurchase.status,
          }
        : null,
      refundNotice: rest.refundNotice,
    };

    // No ticket reservation happened this call — the common case
    // (declining, or a no-op resubmission of an existing purchase).
    if (!freshReservation) {
      return { ...guestResult, paymentAction: null };
    }

    // The one external network call in this whole flow — deliberately
    // AFTER the transaction above has already committed. Failure here
    // is handled by startPaystackCheckout itself (it releases the hold
    // and marks the purchase FAILED via ticketPurchaseService.
    // failPayment), so this RSVP submission still succeeds either way —
    // only paymentAction tells the caller whether checkout is ready or
    // needs a retry.
    const checkout = await ticketPurchaseService.startPaystackCheckout({
      paymentRef: freshReservation.paymentRef,
      totalChargeCents: freshReservation.totalChargeCents,
      platformChargeCents: freshReservation.platformChargeCents,
      // Asserted non-null: reaching this point required
      // guestEmailForPurchase to have been present inside the
      // transaction (submit() throws HttpError(400) beforehand
      // otherwise), and that's exactly what guestEmailForReservation is.
      guestEmail: guestEmailForReservation as string,
      subaccountCode: freshReservation.subaccountCode,
      callbackUrl: frontendUrl(`/rsvp/payment-callback?token=${encodeURIComponent(data.token)}`),
    });

    if ('failed' in checkout) {
      return { ...guestResult, paymentAction: { type: 'retry_needed' as const, reason: checkout.reason } };
    }

    return { ...guestResult, paymentAction: { type: 'redirect' as const, authorizationUrl: checkout.authorizationUrl } };
  },

  // ── RETRY — guest-facing, token-scoped. Re-initiates payment for an
  // existing FAILED/EXPIRED purchase on this invite without touching
  // any other RSVP state (attendance, responses, plus-ones). Does
  // nothing to (and returns the current status of) a PENDING or PAID
  // purchase — see ticketPurchaseService.retryPayment's own comment.
  retryTicketPayment: async (token: string) => {
    const invite = await inviteRepository.findByToken(token);
    if (!invite) {
      throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }

    const purchase = invite.ticketPurchases[0];
    if (!purchase) {
      throw new HttpError(404, 'There is no ticket purchase to retry for this invitation.');
    }

    const ticket = invite.event.tickets.find((t) => t.id === purchase.ticketId);
    if (!ticket) {
      throw new HttpError(404, 'This ticket type is no longer available.');
    }

    const outcome = await ticketPurchaseService.retryPayment({
      purchaseId: purchase.id,
      ticketId: ticket.id,
      ticketPrice: ticket.price,
      currency: ticket.currency,
      quantity: purchase.quantity,
      tenantId: invite.event.tenantId,
    });

    if (outcome.status !== 'RETRYING') {
      return { status: outcome.status, authorizationUrl: null };
    }

    const guestEmail = invite.guest.email;
    if (!guestEmail) {
      throw new HttpError(400, 'An email address is required to purchase a ticket — please add one via the RSVP form first.');
    }

    const checkout = await ticketPurchaseService.startPaystackCheckout({
      paymentRef: outcome.paymentRef,
      totalChargeCents: outcome.totalChargeCents,
      platformChargeCents: outcome.platformChargeCents,
      guestEmail,
      subaccountCode: outcome.subaccountCode,
      callbackUrl: frontendUrl(`/rsvp/payment-callback?token=${encodeURIComponent(token)}`),
    });

    if ('failed' in checkout) {
      return { status: 'FAILED' as const, authorizationUrl: null, reason: checkout.reason };
    }

    return { status: 'RETRYING' as const, authorizationUrl: checkout.authorizationUrl };
  },

  // ── CONFIRM — guest-facing, token-scoped. Called from the Paystack
  // callback landing page. NEVER treats the callback's own return alone
  // as proof of payment — see ticketPurchaseService.reconcile's comment.
  // This just resolves the token to a purchase id and delegates.
  confirmTicketPayment: async (token: string) => {
    const invite = await inviteRepository.findByToken(token);
    if (!invite) {
      throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }

    const purchase = invite.ticketPurchases[0];
    if (!purchase) {
      throw new HttpError(404, 'There is no ticket purchase for this invitation.');
    }

    return ticketPurchaseService.reconcile(purchase.id);
  },
};
