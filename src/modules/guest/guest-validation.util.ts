import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { HttpError } from '../../shared/errors/http-error.js';

const DEFAULT_COUNTRY: CountryCode = 'ZA';

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const assertValidEmail = (raw: string): void => {
  if (!EMAIL_PATTERN.test(raw)) {
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

// Throws a specific, actionable HttpError(400) — distinguishing "you forgot
// the country code" (the common case for South African numbers typed in
// local 0xx format) from a genuinely invalid number, rather than a single
// generic "invalid phone" message.
export const normalizePhoneToE164 = (raw: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string => {
  const trimmed = raw.trim();

  if (trimmed.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (parsed?.isValid()) return parsed.number;
    throw new HttpError(400, `'${raw}' is not a valid phone number`);
  }

  const withDefaultCountry = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (withDefaultCountry?.isValid()) {
    throw new HttpError(400, `'${raw}' is missing a country code, use ${withDefaultCountry.number}`);
  }

  throw new HttpError(400, `'${raw}' is not a valid phone number`);
};

// Product rule: a guest holds exactly one contact method at
// creation/update time — the second field is filled in later, at RSVP
// time. Prisma cannot express this, so it's enforced here on every
// create/update path.
//
// Exception: a plus-one (hostGuestId set) is never contacted directly —
// their host RSVPs on their behalf — so they hold zero contact methods,
// permanently. The "not both" rule still applies unconditionally; only
// the "at least one" rule is skipped for a plus-one.
export const assertExactlyOneContact = (
  email: string | null,
  phoneNumber: string | null,
  hostGuestId: string | null = null
): void => {
  if (email && phoneNumber) {
    throw new HttpError(400, 'A guest can only have one contact method at creation — email or phone, not both');
  }
  if (!hostGuestId && !email && !phoneNumber) {
    throw new HttpError(400, 'A guest must have either an email or a phone number');
  }
};

// plusOnesAllowed is a per-guest allowance (not per-event) set by the
// organiser at create/edit time or via the import template's optional
// column. Enforced here as a simple sanity check; the RSVP flow enforces
// that a guest never declares more plus-ones than this.
export const assertValidPlusOnesAllowed = (value: number): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(400, `'${value}' is not a valid plus-ones allowance — it must be a whole number of 0 or more.`);
  }
};

// Shared duplicate-detection rule (Task 4): a guest is a duplicate if their
// email or phone already belongs to a non-archived guest on the same
// event. Pure — takes a pre-fetched list of existing contacts so both the
// manual-create path (one query) and the import engine (one query, reused
// per row plus an in-file running set) share this exact same check instead
// of re-implementing it.
export interface ExistingContact {
  guestId: string;
  email: string | null;
  phoneNumber: string | null;
}

export const findDuplicateContact = (
  existing: ExistingContact[],
  candidate: { email: string | null; phoneNumber: string | null }
): { guestId: string } | null => {
  for (const contact of existing) {
    if (candidate.email && contact.email && contact.email === candidate.email) {
      return { guestId: contact.guestId };
    }
    if (candidate.phoneNumber && contact.phoneNumber && contact.phoneNumber === candidate.phoneNumber) {
      return { guestId: contact.guestId };
    }
  }
  return null;
};
