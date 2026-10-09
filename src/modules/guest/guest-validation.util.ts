import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { HttpError } from '../../shared/errors/http-error.js';
import { normalizeEmail, isValidEmail } from '../../shared/utils/email.util.js';

const DEFAULT_COUNTRY: CountryCode = 'ZA';

// Moved to shared/utils/email.util.ts (users and team invites use it too);
// re-exported so the guest call sites keep importing it from here.
export { normalizeEmail, isValidEmail };

export const assertValidEmail = (raw: string): void => {
  if (!isValidEmail(raw)) {
    throw new HttpError(400, `'${raw}' is not a valid email address`);
  }
};

// Detects whether a raw contact string looks like an email or a phone
// number by shape, so the import engine can pick the right validator
// without a separate column to declare it.
export type ContactShape = 'email' | 'phone' | 'unknown';

export const detectContactShape = (raw: string): ContactShape => {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return 'email';
  const digitCount = (trimmed.match(/\d/g) ?? []).length;
  if (/^[+\d][\d\s\-()]*$/.test(trimmed) && digitCount >= 6) return 'phone';
  return 'unknown';
};

// Machine-readable codes for a contact the RSVP form can't accept, so the
// client can put the message beside the right field without parsing it
// (STEERING "Machine-readable codes"). The phone codes are set here, so
// every caller of normalizePhoneToE164 carries them; CONTACT_LAST_REMOVED
// is RSVP submit's own (rsvp.service.ts).
export const CONTACT_ERROR_CODES = {
  PHONE_INVALID: 'CONTACT_PHONE_INVALID',
  PHONE_NOT_INTERNATIONAL: 'CONTACT_PHONE_NOT_INTERNATIONAL',
  LAST_REMOVED: 'CONTACT_LAST_REMOVED',
  // RSVP submit with sms off: a guest who has an email removing it (or
  // swapping it for a phone alone). rsvp.service.ts's own, like LAST_REMOVED.
  EMAIL_REQUIRED: 'GUEST_EMAIL_REQUIRED',
  // RSVP submit: an email the guest can't change to, whatever the reason
  // (today: another guest on the event has it). One code and one message
  // for every cause, so the answer never says which applies.
  EMAIL_UNAVAILABLE: 'CONTACT_EMAIL_UNAVAILABLE',
} as const;

export const CONTACT_EMAIL_UNAVAILABLE_MESSAGE = "That email address can't be used for this invitation. Please use another one.";

// The frontend phone rule's own words for a number written with a country
// code that still isn't a real number.
export const PHONE_FORMAT_MESSAGE = 'Use the format +27 82 123 4567';

// Throws a specific, actionable HttpError(400) — distinguishing "you forgot
// the country code" (the common case for South African numbers typed in
// local 0xx format) from a genuinely invalid number, rather than a single
// generic "invalid phone" message. RSVP submit re-raises these as 422,
// code included.
export const normalizePhoneToE164 = (raw: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string => {
  const trimmed = raw.trim();

  if (trimmed.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (parsed?.isValid()) return parsed.number;
    throw new HttpError(400, PHONE_FORMAT_MESSAGE, CONTACT_ERROR_CODES.PHONE_INVALID);
  }

  const withDefaultCountry = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (withDefaultCountry?.isValid()) {
    throw new HttpError(
      400,
      `'${raw}' is missing a country code, use ${withDefaultCountry.number}`,
      CONTACT_ERROR_CODES.PHONE_NOT_INTERNATIONAL
    );
  }

  throw new HttpError(400, `'${raw}' is not a valid phone number`, CONTACT_ERROR_CODES.PHONE_INVALID);
};

// A custom RSVP question of type PHONE: a number written in international
// form ("+27 82 123 4567"), the same test normalizePhoneToE164 applies to
// a contact number. Answers are stored as typed, so this only checks.
export const isInternationalPhoneNumber = (raw: string): boolean => {
  const trimmed = raw.trim();
  return trimmed.startsWith('+') && parsePhoneNumberFromString(trimmed)?.isValid() === true;
};

// Product rule: a guest holds exactly one contact method at CREATION —
// the second field is filled in later, at RSVP time. Prisma cannot express
// this, so it's enforced here on organiser create (guest.service.ts) and
// import (one contact column). Not on update: an organiser editing a
// guest who already holds both (filled in at RSVP) must be able to change
// a name or the plus-ones without being refused for state they didn't
// touch (guest.service.ts's update checks only the fields it changes).
//
// Exception 1: a plus-one (hostGuestId set) is never contacted directly —
// their host RSVPs on their behalf — so they hold zero contact methods,
// permanently. The "not both" rule still applies unconditionally; only
// the "at least one" rule is skipped for a plus-one.
//
// Exception 2: rsvp.service.ts's submit() deliberately does NOT call this
// function. That's where "the second field is filled in later, at RSVP
// time" (above) actually happens, and it can leave a guest holding BOTH
// email and phone — the "not both" half of this rule is intentionally
// guest-facing-exempt, not just unenforced there. See submit()'s own
// comment for why (dispatch routing is unaffected either way) and
// guest-export.util.ts's `contact` column (shows both, joined, rather
// than picking one) for the one other place this was found to matter.
export const assertExactlyOneContact = (
  email: string | null,
  phoneNumber: string | null,
  hostGuestId: string | null = null
): void => {
  if (email && phoneNumber) {
    throw new HttpError(400, 'A guest can only have one contact method at creation — email or phone, not both');
  }
  // 422, not 400: a missing required value, not a malformed request —
  // matching every other required-field refusal (STEERING's Errors table).
  if (!hostGuestId && !email && !phoneNumber) {
    throw new HttpError(422, 'A guest must have either an email or a phone number');
  }
};

// With the sms feature off, nothing can reach a guest by text, so every
// organiser-managed guest needs an email (a phone may still sit beside
// one). Plus-ones have no contact of their own and are exempt. The caller
// decides whether sms is off; this only says what follows from it.
export const GUEST_EMAIL_REQUIRED_MESSAGE = "Add an email address: text messages aren't available yet.";

export const assertGuestHasEmail = (email: string | null, hostGuestId: string | null = null): void => {
  if (!hostGuestId && !email) throw new HttpError(422, GUEST_EMAIL_REQUIRED_MESSAGE);
};

// plusOnesAllowed is a per-guest allowance (not per-event) set by the
// organiser at create/edit time or via the import template's optional
// column, and per registrant by the registration settings. A whole number
// from 0 to 20: nobody brings more to an invitation, and an unbounded
// number could pass the integer column's range and reach the database as
// a 500. The RSVP flow enforces that a guest never declares more plus-ones
// than this.
export const MAX_PLUS_ONES_ALLOWED = 20;
export const GUEST_PLUS_ONES_INVALID = 'GUEST_PLUS_ONES_INVALID';

// Organiser guest edit (guestService.update): the new email is another
// guest's on the same event. A plain message: the organiser can see their
// own guest list, so there's nothing to hide from them (unlike RSVP's
// neutral CONTACT_EMAIL_UNAVAILABLE).
export const GUEST_EMAIL_TAKEN = 'GUEST_EMAIL_TAKEN';
export const PLUS_ONES_ALLOWED_MESSAGE = `Plus-ones allowed must be a whole number from 0 to ${MAX_PLUS_ONES_ALLOWED}.`;

export const isValidPlusOnesAllowed = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PLUS_ONES_ALLOWED;

// 422 with a code: a value the organiser can fix, and the form marks the field.
export const assertValidPlusOnesAllowed = (value: unknown): void => {
  if (!isValidPlusOnesAllowed(value)) throw new HttpError(422, PLUS_ONES_ALLOWED_MESSAGE, GUEST_PLUS_ONES_INVALID);
};

// Shared duplicate-detection rule: a guest is a duplicate if their EMAIL
// already belongs to a non-archived guest on the same event. A phone is
// never anyone's identity — a household, a couple or a PA's number is
// shared by several guests — so two guests on one event may hold the same
// phone, on every path. Pure — takes a pre-fetched list of existing
// contacts so both the manual-create path (one query) and the import
// engine (one query, reused per row plus an in-file running set) share
// this exact same check instead of re-implementing it.
export interface ExistingContact {
  guestId: string;
  email: string | null;
}

export const findDuplicateEmail = (existing: ExistingContact[], email: string | null): { guestId: string } | null => {
  if (!email) return null;
  for (const contact of existing) {
    // Compared in normal form, not as stored: a row the lowercase_emails
    // migration had to skip (a collision) still matches its other casing.
    if (contact.email && normalizeEmail(contact.email) === normalizeEmail(email)) return { guestId: contact.guestId };
  }
  return null;
};
