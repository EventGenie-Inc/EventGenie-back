// ─────────────────────────────────────────
//  EMAIL ADDRESSES — one normal form, everywhere
//
//  Every email this backend stores or compares (users, team invites,
//  guests, sign-in lookups) goes through normalizeEmail first: trimmed and
//  lowercased. "Thandi@Example.com " and "thandi@example.com" are the same
//  person; without this, the unique User.email index treats them as two,
//  a team invite to one can't be accepted by the other, and a guest list
//  holds the same guest twice. Stored rows from before this rule were
//  brought in line by the 20261006091000_lowercase_emails migration.
//
//  Lowercasing the local part is technically stricter than RFC 5321, which
//  lets a mail server treat it case-sensitively. No mainstream provider
//  does, and treating two casings as two people is the far likelier harm.
// ─────────────────────────────────────────

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

// The backend's one email shape check (the frontend's rules.email mirrors
// it). Deliberately loose: it catches typos like a missing "@" or domain,
// not every RFC edge case.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidEmail = (value: string): boolean => EMAIL_PATTERN.test(value);
