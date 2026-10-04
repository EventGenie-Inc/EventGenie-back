// An absolute URL on the frontend, built from FRONTEND_BASE_URL (env config)
// and a path this server chooses. Read at call time, not import time, so the
// value in effect when a message is built is the one it carries. Emails use
// this for every link and image they reference: a domain is never written
// into a message by hand.
export const frontendUrl = (path: string): string =>
  `${(process.env.FRONTEND_BASE_URL ?? '').replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
