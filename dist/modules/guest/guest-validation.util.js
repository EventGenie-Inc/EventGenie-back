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
// create/update path.
export const assertExactlyOneContact = (email, phoneNumber) => {
    if (!email && !phoneNumber) {
        throw new HttpError(400, 'A guest must have either an email or a phone number');
    }
    if (email && phoneNumber) {
        throw new HttpError(400, 'A guest can only have one contact method at creation — email or phone, not both');
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