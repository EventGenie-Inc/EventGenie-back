import { eventRepository } from '../event/event.repository.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { inviteDispatchService } from '../invite/invite-dispatch.service.js';
import { resolveGuestLimit } from '../subscription-tier-config/guest-tier-enforcement.util.js';
import {
  normalizeEmail,
  isValidEmail,
  normalizePhoneToE164,
  CONTACT_ERROR_CODES,
  GUEST_EMAIL_REQUIRED_MESSAGE,
} from '../guest/guest-validation.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventPublicRepository, type RegistrationSeats } from './event-public.repository.js';
import {
  REGISTRATION_ERROR_CODES,
  resolveRegistrationState,
  assertRegistrationOpen,
  assertPartyFits,
  isEmailInAllowedDomains,
  emailDomainRefusal,
  type RegistrationRulesEvent,
} from './registration-rules.util.js';
import {
  type RegisterGuestDto,
  type PublicEventView,
  type RegistrationResult,
  type RegistrationState,
} from './event-public.types.js';

// Fully public/unauthenticated surface — a registrant holds nothing but
// the event's shareToken, never platform credentials. Same audience and
// same rule as rsvp.service.ts's own header comment: every message here
// is written for a reader with no account and no context, and never
// leaks tenant names, internal ids, guest counts, plan language, or
// anything about other guests.
//
// A registrant's personal link (their invite token) is only ever EMAILED,
// never returned: a response carrying it would let anyone register — or
// "register again" — as someone else's address and walk into their
// invitation, and would make the organiser's email-domain restriction
// mean nothing.

type ShareTokenEvent = NonNullable<Awaited<ReturnType<typeof eventRepository.findByShareToken>>>;

const INVALID_LINK_MESSAGE = "This registration link isn't valid. Check the link, or ask the organiser for a new one.";
const MALFORMED_MESSAGE = 'Something went wrong with your registration. Please refresh the page and try again.';
const MAX_NAME_LENGTH = 100;
const NO_SEATS: RegistrationSeats = { primaryGuests: 0, registeredSeats: 0 };

// A PRIVATE event's link is as dead as an unknown one: its old share token
// must not keep showing the event to whoever still has the link.
const findPublicEvent = async (shareToken: string): Promise<ShareTokenEvent> => {
  const event = await eventRepository.findByShareToken(shareToken);
  if (!event || event.visibility !== 'PUBLIC') throw new HttpError(404, INVALID_LINK_MESSAGE);
  return event;
};

const rulesFor = (event: ShareTokenEvent): RegistrationRulesEvent => ({
  status: resolveEffectiveStatus(event),
  rsvpDeadline: event.rsvpDeadline,
  registrationClosesAt: event.registrationClosesAt,
  registrationCap: event.registrationCap,
  eventDays: event.eventDays,
});

// Deliberate, hand-picked projection — exactly what the registration page
// shows (PublicEventView). Built as an explicit allowlist, never a spread
// of the Prisma row, so a column added to Event or EventDay later can't
// start leaking by itself (STEERING "Guest-facing responses").
const toPublicView = (event: ShareTokenEvent, state: RegistrationState): PublicEventView => ({
  name: event.name,
  hostName: event.hostName,
  description: event.description,
  coverImageUrl: event.coverImageUrl,
  // Live days, earliest first (eventRepository.findByShareToken).
  days: event.eventDays.map((d) => ({
    id: d.id,
    label: d.label,
    date: d.date,
    startTime: d.startTime,
    endTime: d.endTime,
    location: d.location,
    address: d.address,
    openForRegistration: d.openForRegistration,
  })),
  registration: {
    isOpen: state.isOpen,
    reason: state.reason,
    message: state.message,
    closesAt: state.closesAt,
    plusOnesAllowed: event.registrationPlusOnesAllowed,
    allowedEmailDomains: event.registrationEmailDomains,
  },
});

// ─────────────────────────────────────────
//  THE REGISTRATION FORM, checked
//
//  Every field arrives from an unauthenticated POST body. A wrong TYPE is
//  a tampered or broken request (400, one generic message); a blank or
//  unacceptable VALUE is something the registrant can fix (422, saying
//  what to fix). Emails are normalised before every check that follows.
// ─────────────────────────────────────────
interface ParsedRegistration {
  firstName: string;
  surname: string | null;
  email: string;
  phoneNumber: string | null;
  dayIds: string[] | null;
  plusOneNames: string[];
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const optionalText = (value: unknown): string | null => {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw new HttpError(400, MALFORMED_MESSAGE);
  return value.trim();
};

const assertNameLength = (name: string, what: string, code: string): void => {
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpError(422, `${what} can be at most ${MAX_NAME_LENGTH} characters.`, code);
  }
};

// normalizePhoneToE164's 400s carry the contact codes; a registrant typing
// a wrong number is a value to fix (422), as at RSVP.
const parsePhone = (value: unknown): string | null => {
  const raw = optionalText(value);
  if (raw === null) return null;
  try {
    return normalizePhoneToE164(raw);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 400) throw new HttpError(422, err.message, err.code);
    throw err;
  }
};

const parseRegistration = (data: RegisterGuestDto): ParsedRegistration => {
  if (typeof data !== 'object' || data === null) throw new HttpError(400, MALFORMED_MESSAGE);

  const firstName = optionalText(data.firstName);
  if (firstName === null) {
    throw new HttpError(422, 'Please tell us your name to register.', REGISTRATION_ERROR_CODES.FIRST_NAME_REQUIRED);
  }
  assertNameLength(firstName, 'Your first name', REGISTRATION_ERROR_CODES.FIRST_NAME_TOO_LONG);
  const surname = optionalText(data.surname);
  if (surname !== null) assertNameLength(surname, 'Your surname', REGISTRATION_ERROR_CODES.SURNAME_TOO_LONG);

  // Required whatever the sms flag says: the personal link is emailed.
  const rawEmail = optionalText(data.email);
  if (rawEmail === null) {
    throw new HttpError(
      422,
      isFeatureEnabled('sms') ? 'Enter your email address: your personal link is sent there.' : GUEST_EMAIL_REQUIRED_MESSAGE,
      CONTACT_ERROR_CODES.EMAIL_REQUIRED
    );
  }
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    throw new HttpError(422, `'${rawEmail}' is not a valid email address`, REGISTRATION_ERROR_CODES.EMAIL_INVALID);
  }

  const phoneNumber = parsePhone(data.phoneNumber);

  let dayIds: string[] | null = null;
  if (data.dayIds !== undefined && data.dayIds !== null) {
    if (!Array.isArray(data.dayIds) || !data.dayIds.every((id) => typeof id === 'string' && id.length > 0)) {
      throw new HttpError(400, MALFORMED_MESSAGE);
    }
    if (data.dayIds.length === 0) {
      throw new HttpError(422, 'Choose at least one day you’ll attend.', REGISTRATION_ERROR_CODES.NO_DAYS_CHOSEN);
    }
    dayIds = [...new Set(data.dayIds as string[])];
  }

  let plusOneNames: string[] = [];
  if (data.plusOneNames !== undefined && data.plusOneNames !== null) {
    if (!Array.isArray(data.plusOneNames) || !data.plusOneNames.every((n) => typeof n === 'string')) {
      throw new HttpError(400, MALFORMED_MESSAGE);
    }
    plusOneNames = (data.plusOneNames as string[]).map((n) => n.trim());
    if (plusOneNames.some((n) => n.length === 0)) {
      throw new HttpError(422, "Please give each plus-one's name.", REGISTRATION_ERROR_CODES.PLUS_ONE_NAME_REQUIRED);
    }
    plusOneNames.forEach((n) => assertNameLength(n, "A plus-one's name", REGISTRATION_ERROR_CODES.PLUS_ONE_NAME_TOO_LONG));
  }

  return { firstName, surname, email, phoneNumber, dayIds, plusOneNames };
};

// ─────────────────────────────────────────
//  THE ANSWER
//
//  One answer, whether the email was new or already a guest: the same
//  status (201), outcome and message, byte for byte. A different answer
//  for an address already on the list would let anyone with the link test
//  addresses against the guest list. Only the email differs, and only
//  its owner reads it: a new registrant gets "You're registered", someone
//  already registered gets their link again.
// ─────────────────────────────────────────
const REGISTERED_MESSAGE = 'Check your email for your e-velope.';
const SEND_FAILED_MESSAGE =
  "We couldn't send your email just now. Register again with the same email address in a few minutes and we'll send it.";

const registrationAnswer = (emailSent: boolean): RegistrationResult => ({
  outcome: 'REGISTERED',
  emailSent,
  message: emailSent ? REGISTERED_MESSAGE : SEND_FAILED_MESSAGE,
});

// Someone already on this event's guest list registering with the same
// email: no second guest. Their own link is emailed to that address again
// (only its owner can read it). Returns whether it was sent.
const resendExistingInvitation = async (
  event: ShareTokenEvent,
  guest: { id: string; selfRegisteredAt: Date | null },
  email: string
): Promise<boolean> => {
  const invite = await eventPublicRepository.findLatestInviteForGuest(guest.id);
  // Every invite of theirs was archived by the organiser: that's the
  // organiser's decision to undo, not this page's. Nothing is sent, and
  // the answer is still the ordinary one (STEERING "Public events and
  // self-registration").
  if (!invite) return true;

  const attending = invite.attendances.map((a) => a.eventDay);
  const days = attending.length > 0 ? attending : invite.inviteEventDay.map((d) => d.eventDay);
  const { ok } = await inviteDispatchService.sendRegistrationEmail(
    event,
    invite,
    email,
    days,
    guest.selfRegisteredAt ? 'REGISTRATION_RESEND' : 'INVITE'
  );
  return ok;
};

export const eventPublicService = {
  // Public, unauthenticated read — resolved purely from the shareToken.
  // A closed, full or cancelled event still shows (name, cover, days) with
  // the reason registration isn't open, rather than a bare error. An
  // unknown, revoked or private-event token is the one 404.
  viewByShareToken: async (shareToken: string): Promise<PublicEventView> => {
    const event = await findPublicEvent(shareToken);
    const [seats, { limit }] = await Promise.all([eventPublicRepository.countSeats(event.id), resolveGuestLimit(event)]);
    return toPublicView(event, resolveRegistrationState(rulesFor(event), seats, limit));
  },

  // Creates the guest and their accepted invite (their days, their
  // plus-ones) and emails them their personal link, so they can change
  // their answer later like any guest.
  //
  // Every check runs in the same order whether or not the email is
  // already a guest, and an existing guest gets exactly the answer a new
  // registration with the same request would: the success, or the same
  // refusal. Nothing a registrant can see depends on whether the address
  // is on the list (registrationAnswer above).
  register: async (shareToken: string, data: RegisterGuestDto): Promise<RegistrationResult> => {
    const input = parseRegistration(data);
    const event = await findPublicEvent(shareToken);
    const rules = rulesFor(event);

    // Cancelled, over, or not yet open: nothing to register for, and no
    // link worth re-sending either.
    if (rules.status !== 'PUBLISHED') assertRegistrationOpen(resolveRegistrationState(rules, NO_SEATS, null));

    if (!isEmailInAllowedDomains(input.email, event.registrationEmailDomains)) {
      throw emailDomainRefusal(event.registrationEmailDomains);
    }

    const openDayIds = event.eventDays.filter((d) => d.openForRegistration).map((d) => d.id);
    const attendingDayIds = input.dayIds ?? openDayIds;
    if (attendingDayIds.some((id) => !openDayIds.includes(id))) {
      throw new HttpError(
        422,
        "One of the days you chose isn't open for registration. Please refresh the page and choose again.",
        REGISTRATION_ERROR_CODES.DAY_NOT_OPEN
      );
    }

    const allowance = event.registrationPlusOnesAllowed;
    if (input.plusOneNames.length > allowance) {
      throw new HttpError(
        422,
        allowance === 0
          ? "Plus-ones can't be added when registering for this event."
          : `You can bring up to ${allowance} plus-one${allowance === 1 ? '' : 's'}. Please remove some and try again.`,
        REGISTRATION_ERROR_CODES.TOO_MANY_PLUS_ONES
      );
    }

    const { limit } = await resolveGuestLimit(event);

    // Counted and written under the event's row lock, so two registrations
    // can't both take the last seat or both create the same email.
    const outcome = await eventPublicRepository.withEventRegistrationLock(event.id, async (tx) => {
      const existing = await eventPublicRepository.findGuestByEmail(event.id, input.email, tx);
      const seats = await eventPublicRepository.countSeats(event.id, tx);

      // What a new registration gets here: closed (the closing date, no
      // open day), full, or no room for this party.
      let refusal: HttpError | null = null;
      try {
        assertRegistrationOpen(resolveRegistrationState(rules, seats, limit));
        assertPartyFits(event, seats, limit, 1 + input.plusOneNames.length);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        refusal = err;
      }

      if (existing) return { existing, refusal } as const;
      if (refusal) throw refusal;

      // A phone is saved as given, even if another guest on the event has
      // the same one: guests may share a phone (guest-validation.util.ts).
      const registrant = await eventPublicRepository.createRegistrant(
        tx,
        event.id,
        {
          firstName: input.firstName,
          surname: input.surname,
          email: input.email,
          phoneNumber: input.phoneNumber,
          plusOnesAllowed: allowance,
          invitedDayIds: openDayIds,
          attendingDayIds,
          plusOneNames: input.plusOneNames,
        },
        new Date()
      );
      return { registrant } as const;
    });

    // Already a guest: they're sent their own link whatever the answer
    // (a closing date or a full cap still re-sends it), and get the answer
    // a new registration would. Nothing about them changes.
    if ('existing' in outcome) {
      const sent = await resendExistingInvitation(event, outcome.existing, input.email);
      if (outcome.refusal) throw outcome.refusal;
      return registrationAnswer(sent);
    }

    // After the commit: a failed send leaves a real registration, and
    // registering again with the same email re-sends it.
    const days = event.eventDays.filter((d) => attendingDayIds.includes(d.id));
    const { ok } = await inviteDispatchService.sendRegistrationEmail(event, outcome.registrant.invite, input.email, days, 'REGISTRATION');
    return registrationAnswer(ok);
  },
};
