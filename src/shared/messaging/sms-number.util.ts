import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

// ─────────────────────────────────────────
//  SOUTH AFRICAN NUMBERS
//
//  Two jobs:
//  - normaliseSouthAfricanNumber: a number typed the way South Africans
//    write it (082 123 4567, 27 82 123 4567, 0027 82 123 4567, +27 (0)82…)
//    becomes international form, +27821234567. Used wherever a guest's
//    phone is saved (guest-validation.util.ts's normalizePhoneToE164).
//  - smsDestinationFor: whether a stored number can be texted, checked when
//    a text is queued and again when it goes. Texts go to South African
//    mobile numbers only: SMS bundles and the monthly allowance count
//    South African parts, and an international text costs SMSPortal
//    several credits. Each refusal has a code and words for the organiser.
//
//  The full metadata (libphonenumber-js/max) is needed to tell a mobile
//  number from a landline; the default build can't.
// ─────────────────────────────────────────

export const SMS_NUMBER_CODES = {
  INVALID: 'SMS_NUMBER_INVALID',
  NOT_MOBILE: 'SMS_NUMBER_NOT_MOBILE',
  NOT_SOUTH_AFRICAN: 'SMS_NUMBER_NOT_SOUTH_AFRICAN',
} as const;

export type SmsNumberCode = (typeof SMS_NUMBER_CODES)[keyof typeof SMS_NUMBER_CODES];

export const SMS_NUMBER_MESSAGES: Record<SmsNumberCode, string> = {
  SMS_NUMBER_INVALID: "This guest's phone number isn't a valid number, so no text was sent. Correct it and send again.",
  SMS_NUMBER_NOT_MOBILE: "This guest's phone number isn't a mobile number, so it can't receive a text. Add a mobile number or an email address.",
  SMS_NUMBER_NOT_SOUTH_AFRICAN:
    "Text messages go to South African mobile numbers only, so nothing was sent to this guest. Add an email address for them.",
};

// Digits only, with a leading "+" kept. "(0)" after a country code is the
// trunk zero people write in brackets: "+27 (0)82…" is "+2782…".
const compact = (raw: string): string => {
  const trimmed = raw.trim().replace(/\(0\)/g, '');
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return plus ? `+${digits}` : digits;
};

// The number in international form (E.164) when it is a valid South African
// number however it was written, else null. A number already written with
// another country's code is not this function's to judge: null.
export const normaliseSouthAfricanNumber = (raw: string): string | null => {
  let candidate = compact(raw);
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  if (!candidate.startsWith('+') && /^27\d{9}$/.test(candidate)) candidate = `+${candidate}`;
  // "+270821234567": the trunk zero kept after the country code.
  if (/^\+270\d{9}$/.test(candidate)) candidate = `+27${candidate.slice(4)}`;

  const parsed = candidate.startsWith('+') ? parsePhoneNumberFromString(candidate) : parsePhoneNumberFromString(candidate, 'ZA');
  return parsed?.isValid() && parsed.country === 'ZA' && parsed.nationalNumber.length === SA_NATIONAL_DIGITS ? parsed.number : null;
};

// Every South African number, mobile or landline, is 9 digits after +27
// (10 with the leading 0). The library's ZA metadata also accepts short
// numbers ("082555" as +2782555, "valid" and "MOBILE"), which no phone can
// be texted or called on, so they are refused here and in
// guest-validation.util.ts.
export const SA_NATIONAL_DIGITS = 9;

export const isShortSouthAfricanNumber = (parsed: { country?: string | undefined; nationalNumber: string }): boolean =>
  parsed.country === 'ZA' && parsed.nationalNumber.length !== SA_NATIONAL_DIGITS;

export type SmsDestination = { ok: true; e164: string } | { ok: false; code: SmsNumberCode; reason: string };

const refuse = (code: SmsNumberCode): SmsDestination => ({ ok: false, code, reason: SMS_NUMBER_MESSAGES[code] });

// Can this stored number be texted? It is normalised first, so a number
// saved before the normalisation (or written locally) still goes.
export const smsDestinationFor = (stored: string | null | undefined): SmsDestination => {
  if (!stored?.trim()) return refuse(SMS_NUMBER_CODES.INVALID);
  const southAfrican = normaliseSouthAfricanNumber(stored);
  if (!southAfrican) {
    const other = compact(stored).startsWith('+') ? parsePhoneNumberFromString(compact(stored)) : undefined;
    return refuse(other?.isValid() ? SMS_NUMBER_CODES.NOT_SOUTH_AFRICAN : SMS_NUMBER_CODES.INVALID);
  }
  const type = parsePhoneNumberFromString(southAfrican)?.getType();
  if (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') return refuse(SMS_NUMBER_CODES.NOT_MOBILE);
  return { ok: true, e164: southAfrican };
};
