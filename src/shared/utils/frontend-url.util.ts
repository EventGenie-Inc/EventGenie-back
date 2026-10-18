// An absolute URL on the frontend, built from FRONTEND_BASE_URL (env config)
// and a path this server chooses. Read at call time, not import time, so the
// value in effect when a message is built is the one it carries. Every link
// this server hands out is built here: emails (every link and image they
// reference), share links and payment callbacks. A domain is never written
// into a message by hand, and process.env.FRONTEND_BASE_URL is read nowhere
// else.

export const FRONTEND_BASE_URL_ENV = 'FRONTEND_BASE_URL';

// The configured base without trailing slashes. Missing, blank, or not an
// absolute http(s) URL throws: a link built from it would read
// "undefined/register?…" or point nowhere, and an email or SMS carrying one
// can't be recalled.
const frontendBaseUrl = (): string => {
  const raw = (process.env[FRONTEND_BASE_URL_ENV] ?? '').trim();
  let protocol: string | null = null;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    protocol = null;
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(
      `${FRONTEND_BASE_URL_ENV} must be set to the frontend's absolute URL (e.g. https://e-velope.co.za); ` +
        `it is ${raw ? `'${raw}'` : 'missing'}. Every link this server sends is built from it.`
    );
  }
  return raw.replace(/\/+$/, '');
};

export const frontendUrl = (path: string): string =>
  `${frontendBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;

// Called when app.ts loads, beside assertFeatureConfigValid: the app refuses
// to start rather than serve links built from nothing.
export const assertFrontendUrlConfigured = (): void => {
  frontendBaseUrl();
};
