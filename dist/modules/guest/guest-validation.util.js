import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { HttpError } from '../../shared/errors/http-error.js';
const DEFAULT_COUNTRY = 'ZA';
export const normalizeEmail = (raw) => raw.trim().toLowerCase();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const assertValidEmail = (raw) => {
    if (!EMAIL_PATTERN.test(raw)) {
        throw new HttpError(400, `'${raw}' is not a valid email address`);
    }
};
export const detectContactShape = (raw) => {
    const trimmed = raw.trim();
    if (trimmed.includes('@'))
        return 'email';
    const digitCount = (trimmed.match(/\d/g) ?? []).length;
    if (/^[+\d][\d\s\-()]*$/.test(trimmed) && digitCount >= 6)
        return 'phone';
    return 'unknown';
};
// Throws a specific, actionable HttpError(400) — distinguishing "you forgot
// the country code" (the common case for South African numbers typed in
// local 0xx format) from a genuinely invalid number, rather than a single
// generic "invalid phone" message.
export const normalizePhoneToE164 = (raw, defaultCountry = DEFAULT_COUNTRY) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('+')) {
        const parsed = parsePhoneNumberFromString(trimmed);
        if (parsed?.isValid())
            return parsed.number;
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
// organiser create/update path (guest.service.ts).
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
export const assertExactlyOneContact = (email, phoneNumber, hostGuestId = null) => {
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
export const assertValidPlusOnesAllowed = (value) => {
    if (!Number.isInteger(value) || value < 0) {
        throw new HttpError(400, `'${value}' is not a valid plus-ones allowance — it must be a whole number of 0 or more.`);
    }
};
export const findDuplicateContact = (existing, candidate) => {
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
//# sourceMappingURL=guest-validation.util.js.map