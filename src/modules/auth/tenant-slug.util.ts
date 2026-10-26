import { HttpError } from '../../shared/errors/http-error.js';

// ─────────────────────────────────────────
//  THE ORGANISATION ADDRESS (Tenant.slug) AT SIGN-UP
//
//  Optional on POST /api/auth/register. Blank or missing: made from the
//  organisation's name. Typed: must already be a valid address, or it is
//  422 TENANT_SLUG_INVALID (never silently rewritten into something the
//  person didn't type). Either way, an address another tenant has (archived
//  ones included: the column is unique) is never a refusal: the next free
//  one is used instead, name-2, name-3 and so on.
// ─────────────────────────────────────────
export const TENANT_SLUG_MAX_CHARS = 60;
export const TENANT_SLUG_INVALID = 'TENANT_SLUG_INVALID';
export const TENANT_SLUG_INVALID_MESSAGE =
  `Use only lowercase letters, numbers and single hyphens in the organisation address, up to ${TENANT_SLUG_MAX_CHARS} characters (for example sarah-and-tom).`;

// For a name that has no letters or numbers to make one from.
const FALLBACK_SLUG = 'organisation';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The frontend's slugify (register-screen.ts), plus accents dropped first
// ("Café" -> "cafe", not "caf").
const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const trimToLength = (slug: string, max: number): string => slug.slice(0, max).replace(/-+$/, '');

// The address to start from: the typed one, checked, or one made from the
// name. Not yet checked against other tenants.
export const resolveBaseSlug = (tenantSlug: unknown, tenantName: string): string => {
  if (tenantSlug === undefined || tenantSlug === null) return fromName(tenantName);
  if (typeof tenantSlug !== 'string') throw new HttpError(400, 'tenantSlug must be text.');
  const typed = tenantSlug.trim().toLowerCase();
  if (!typed) return fromName(tenantName);
  if (typed.length > TENANT_SLUG_MAX_CHARS || !SLUG_PATTERN.test(typed)) {
    throw new HttpError(422, TENANT_SLUG_INVALID_MESSAGE, TENANT_SLUG_INVALID);
  }
  return typed;
};

const fromName = (tenantName: string): string =>
  trimToLength(slugify(tenantName), TENANT_SLUG_MAX_CHARS) || FALLBACK_SLUG;

// The nth address to try: the base itself, then base-2, base-3, ... The base
// is shortened when the suffix would take it past the limit.
export const slugCandidate = (base: string, n: number): string => {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return `${trimToLength(base, TENANT_SLUG_MAX_CHARS - suffix.length)}${suffix}`;
};
