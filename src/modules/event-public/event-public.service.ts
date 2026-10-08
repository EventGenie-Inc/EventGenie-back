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
  describeAllowedDomains,
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

const assertNameLength = (name: string, what: string): void => {
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpError(422, `${what} can be at most ${MAX_NAME_LENGTH} characters.`);
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
  if (firstName === null) throw new HttpError(422, 'Please tell us your name to register.');
  assertNameLength(firstName, 'Your first name');
  const surname = optionalText(data.surname);
  if (surname !== null) assertNameLength(surname, 'Your surname');

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
  if (!isValidEmail(email)) throw new HttpError(422, `'${rawEmail}' is not a valid email address`);

  const phoneNumber = parsePhone(data.phoneNumber);

  let dayIds: string[] | null = null;
  if (data.dayIds !== undefined && data.dayIds !== null) {
    if (!Array.isArray(data.dayIds) || !data.dayIds.every((id) => typeof id === 'string' && id.length > 0)) {
      throw new HttpError(400, MALFORMED_MESSAGE);
    }
    if (data.dayIds.length === 0) throw new HttpError(422, 'Choose at least one day you’ll attend.');
    dayIds = [...new Set(data.dayIds as string[])];
  }

  let plusOneNames: string[] = [];
  if (data.plusOneNames !== undefined && data.plusOneNames !== null) {
    if (!Array.isArray(data.plusOneNames) || !data.plusOneNames.every((n) => typeof n === 'string')) {
      throw new HttpError(400, MALFORMED_MESSAGE);
    }
    plusOneNames = (data.plusOneNames as string[]).map((n) => n.trim());
    if (plusOneNames.some((n) => n.length === 0)) throw new HttpError(422, "Please give each plus-one's name.");
    plusOneNames.forEach((n) => assertNameLength(n, "A plus-one's name"));
  }

  return { firstName, surname, email, phoneNumber, dayIds, plusOneNames };
};

// Someone already on this event's guest list registering with the same
// email: no second guest. Their own link is emailed to that address again
// (only its owner can read it), and the response says so and nothing
// else — not their name, their answer or their days.
const resendExistingInvitation = async (
  event: ShareTokenEvent,
  guest: { id: string; selfRegisteredAt: Date | null },
  email: string
): Promise<RegistrationResult> => {
  const invite = await eventPublicRepository.findLatestInviteForGuest(guest.id);
  if (!invite) {
    // Every invite of theirs was archived by the organiser: that's the
    // organiser's decision to undo, not this page's. No new invite.
    return {
      outcome: 'ALREADY_REGISTERED',
      emailSent: false,
      message: "You're already registered for this event. Contact the organiser for your link.",
    };
  }

  const attending = invite.attendances.map((a) => a.eventDay);
  const days = attending.length > 0 ? attending : invite.inviteEventDay.map((d) => d.eventDay);
  const { ok } = await inviteDispatchService.sendRegistrationEmail(
    event,
    invite,
    email,
    days,
    guest.selfRegisteredAt ? 'REGISTRATION' : 'INVITE'
  );
  return {
    outcome: 'ALREADY_REGISTERED',
    emailSent: ok,
    message: ok
      ? `You're already registered for this event. We've sent your personal link to ${email} again.`
      : "You're already registered for this event, but we couldn't send your email just now. Please try again in a few minutes.",
  };
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
  register: async (shareToken: string, data: RegisterGuestDto): Promise<RegistrationResult> => {
    const input = parseRegistration(data);
    const event = await findPublicEvent(shareToken);
    const rules = rulesFor(event);

    // Without counts: refuses only on the event's state and dates.
    const preliminary = resolveRegistrationState(rules, NO_SEATS, null);
    // Cancelled, over, or not yet open: nothing to register for, and no
    // link worth re-sending either.
    if (rules.status !== 'PUBLISHED') assertRegistrationOpen(preliminary);

    // Before the duplicate check, so the response never says whether an
    // address outside the allowed domains is on the guest list.
    if (!isEmailInAllowedDomains(input.email, event.registrationEmailDomains)) {
      throw new HttpError(
        422,
        `Register with ${describeAllowedDomains(event.registrationEmailDomains)}.`,
        REGISTRATION_ERROR_CODES.EMAIL_DOMAIN
      );
    }

    // An existing registrant isn't a new registration: the closing date
    // and the cap don't stop their link being re-sent.
    const existing = await eventPublicRepository.findGuestByEmail(event.id, input.email);
    if (existing) return resendExistingInvitation(event, existing, input.email);

    assertRegistrationOpen(preliminary); // closing date, no open day

    const openDayIds = event.eventDays.filter((d) => d.openForRegistration).map((d) => d.id);
    const attendingDayIds = input.dayIds ?? openDayIds;
    if (attendingDayIds.some((id) => !openDayIds.includes(id))) {
      throw new HttpError(422, "One of the days you chose isn't open for registration. Please refresh the page and choose again.");
    }

    const allowance = event.registrationPlusOnesAllowed;
    if (input.plusOneNames.length > allowance) {
      throw new HttpError(
        422,
        allowance === 0
          ? "Plus-ones can't be added when registering for this event."
          : `You can bring up to ${allowance} plus-one${allowance === 1 ? '' : 's'}. Please remove some and try again.`
      );
    }

    const { limit } = await resolveGuestLimit(event);

    // Counted and written under the event's row lock, so two registrations
    // can't both take the last seat or both create the same email.
    const created = await eventPublicRepository.withEventRegistrationLock(event.id, async (tx) => {
      const raced = await eventPublicRepository.findGuestByEmail(event.id, input.email, tx);
      if (raced) return { duplicate: raced } as const;

      const seats = await eventPublicRepository.countSeats(event.id, tx);
      assertRegistrationOpen(resolveRegistrationState(rules, seats, limit));
      assertPartyFits(event, seats, limit, 1 + input.plusOneNames.length);

      // Same duplicate rule, and the same words, as a guest changing their
      // number at RSVP.
      if (input.phoneNumber && (await eventPublicRepository.findGuestIdByPhone(event.id, input.phoneNumber, tx))) {
        throw new HttpError(409, 'Another guest on this event is already using this phone number.');
      }

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

    if ('duplicate' in created) return resendExistingInvitation(event, created.duplicate, input.email);

    // After the commit: a failed send leaves a real registration, and
    // registering again with the same email re-sends it.
    const days = event.eventDays.filter((d) => attendingDayIds.includes(d.id));
    const { ok } = await inviteDispatchService.sendRegistrationEmail(event, created.registrant.invite, input.email, days, 'REGISTRATION');
    return {
      outcome: 'REGISTERED',
      emailSent: ok,
      message: ok
        ? `You're registered! We've sent your personal link to ${input.email}.`
        : "You're registered, but we couldn't send your email just now. Register again with the same email address in a few minutes and we'll re-send it.",
    };
  },
};
