import { type EventStatus } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { type RegistrationClosedReason, type RegistrationState } from './event-public.types.js';
import { type RegistrationSeats } from './event-public.repository.js';

// ─────────────────────────────────────────
//  PUBLIC REGISTRATION RULES — one place, three readers
//
//  The public view (is registration open, and why not), register (refuse
//  with the same reason) and the organiser's registration settings (the
//  state they're looking at) all decide through resolveRegistrationState,
//  so the page, the refusal and the organiser screen can never disagree.
//
//  Every message here is read by a registrant: no plan, tier or limit
//  language (STEERING "Guest-facing responses"), and no guest counts. The
//  plan's guest limit and the organiser's cap are one state to them: full.
// ─────────────────────────────────────────

export const REGISTRATION_ERROR_CODES = {
  CANCELLED: 'REGISTRATION_EVENT_CANCELLED',
  CLOSED: 'REGISTRATION_CLOSED',
  FULL: 'REGISTRATION_FULL',
  // Room left, but not for this many people: the form marks the plus-ones.
  PARTY_TOO_LARGE: 'REGISTRATION_PARTY_TOO_LARGE',
  EMAIL_DOMAIN: 'REGISTRATION_EMAIL_DOMAIN',
  // More plus-ones than the organiser allows each registrant (vs
  // PARTY_TOO_LARGE, which is the cap): the form marks the plus-ones.
  TOO_MANY_PLUS_ONES: 'REGISTRATION_TOO_MANY_PLUS_ONES',
  // A chosen day isn't open to registration (the page is out of date).
  DAY_NOT_OPEN: 'REGISTRATION_DAY_NOT_OPEN',
  // One per name field, so the form marks the right one.
  FIRST_NAME_TOO_LONG: 'REGISTRATION_FIRST_NAME_TOO_LONG',
  SURNAME_TOO_LONG: 'REGISTRATION_SURNAME_TOO_LONG',
  PLUS_ONE_NAME_TOO_LONG: 'REGISTRATION_PLUS_ONE_NAME_TOO_LONG',
  // The form's remaining refusals, one per field.
  FIRST_NAME_REQUIRED: 'REGISTRATION_FIRST_NAME_REQUIRED',
  EMAIL_INVALID: 'REGISTRATION_EMAIL_INVALID',
  NO_DAYS_CHOSEN: 'REGISTRATION_NO_DAYS_CHOSEN',
  PLUS_ONE_NAME_REQUIRED: 'REGISTRATION_PLUS_ONE_NAME_REQUIRED',
} as const;

const CODE_FOR_REASON: Record<RegistrationClosedReason, string> = {
  CANCELLED: REGISTRATION_ERROR_CODES.CANCELLED,
  CLOSED: REGISTRATION_ERROR_CODES.CLOSED,
  FULL: REGISTRATION_ERROR_CODES.FULL,
};

// Cancelled and closed are gone for good (410, as the RSVP deadline
// already is); full is the event's current state and may change (409).
const STATUS_FOR_REASON: Record<RegistrationClosedReason, number> = {
  CANCELLED: 410,
  CLOSED: 410,
  FULL: 409,
};

export const REGISTRATION_FULL_MESSAGE =
  'Registration for this event is full. Contact the organiser if you still hope to attend.';

export interface RegistrationRulesEvent {
  status: EventStatus; // effective status (resolveEffectiveStatus)
  rsvpDeadline: Date | null;
  registrationClosesAt: Date | null;
  registrationCap: number | null;
  eventDays: { openForRegistration: boolean }[]; // live days only
}

// The organiser's closing date or the RSVP deadline, whichever is first:
// registration never stays open past the RSVP deadline, since a registrant
// becomes a guest who can only change their answer until then.
export const effectiveClosesAt = (event: { rsvpDeadline: Date | null; registrationClosesAt: Date | null }): Date | null => {
  const dates = [event.registrationClosesAt, event.rsvpDeadline].filter((d): d is Date => d !== null);
  if (dates.length === 0) return null;
  return dates.reduce((earliest, d) => (d < earliest ? d : earliest));
};

// Is anyone else at all able to register right now. `seats` and
// `guestLimit` (the plan's, null = unlimited) are only read for FULL.
export const resolveRegistrationState = (
  event: RegistrationRulesEvent,
  seats: RegistrationSeats,
  guestLimit: number | null,
  now: Date = new Date()
): RegistrationState => {
  const closesAt = effectiveClosesAt(event);
  const closed = (reason: RegistrationClosedReason, message: string): RegistrationState => ({
    isOpen: false,
    reason,
    message,
    closesAt,
  });

  if (event.status === 'CANCELLED') return closed('CANCELLED', 'This event has been cancelled.');
  if (event.status === 'COMPLETED') return closed('CLOSED', 'This event has already taken place.');
  // Defensive: a share link is only ever minted for a published event,
  // and publishing has no reversal.
  if (event.status !== 'PUBLISHED') return closed('CLOSED', 'Registration for this event is not open yet.');
  if (closesAt && closesAt <= now) {
    return closed('CLOSED', `Registration for this event closed on ${formatGuestDate(closesAt)}.`);
  }
  if (!event.eventDays.some((d) => d.openForRegistration)) {
    return closed('CLOSED', 'Registration for this event is not open.');
  }
  const capReached = event.registrationCap !== null && seats.registeredSeats >= event.registrationCap;
  const planReached = guestLimit !== null && seats.primaryGuests >= guestLimit;
  if (capReached || planReached) return closed('FULL', REGISTRATION_FULL_MESSAGE);

  return { isOpen: true, reason: null, message: null, closesAt };
};

export const assertRegistrationOpen = (state: RegistrationState): void => {
  if (state.isOpen || !state.reason) return;
  throw new HttpError(STATUS_FOR_REASON[state.reason], state.message ?? REGISTRATION_FULL_MESSAGE, CODE_FOR_REASON[state.reason]);
};

// Can a party of `partySize` (the registrant plus their plus-ones) fit.
// The cap counts every seat; the plan's limit counts primary guests only
// (guestRepository.countForEvent's rule), so a party adds one there.
export const assertPartyFits = (
  event: { registrationCap: number | null },
  seats: RegistrationSeats,
  guestLimit: number | null,
  partySize: number
): void => {
  const capReached = event.registrationCap !== null && seats.registeredSeats >= event.registrationCap;
  const planReached = guestLimit !== null && seats.primaryGuests >= guestLimit;
  if (capReached || planReached) {
    throw new HttpError(409, REGISTRATION_FULL_MESSAGE, REGISTRATION_ERROR_CODES.FULL);
  }
  if (event.registrationCap !== null && seats.registeredSeats + partySize > event.registrationCap) {
    throw new HttpError(
      409,
      "There isn't room for everyone in your party. Try registering with fewer plus-ones.",
      REGISTRATION_ERROR_CODES.PARTY_TOO_LARGE
    );
  }
};

// ─────────────────────────────────────────
//  EMAIL DOMAINS
//
//  Stored lowercase, without "@". A registrant's email (already
//  normalised) is allowed when its domain is exactly one of them:
//  "company.co.za" does not admit "mail.company.co.za" or
//  "othercompany.co.za". Empty list = anyone.
// ─────────────────────────────────────────

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const normalizeEmailDomain = (raw: string): string => raw.trim().toLowerCase().replace(/^@+/, '');

export const isValidEmailDomain = (domain: string): boolean => DOMAIN_PATTERN.test(domain);

export const emailDomainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1);

export const isEmailInAllowedDomains = (email: string, allowedDomains: string[]): boolean =>
  allowedDomains.length === 0 || allowedDomains.includes(emailDomainOf(email));

export const describeAllowedDomains = (domains: string[]): string =>
  domains.length === 1
    ? `your ${domains[0]} email address`
    : `an email address at ${domains.slice(0, -1).join(', ')} or ${domains[domains.length - 1]}`;

// The one refusal for an email outside the domains: at registration and
// when a guest changes their email at RSVP (rsvp.service.ts).
export const emailDomainRefusal = (domains: string[]): HttpError =>
  new HttpError(422, `Register with ${describeAllowedDomains(domains)}.`, REGISTRATION_ERROR_CODES.EMAIL_DOMAIN);
