import { HttpError } from '../../shared/errors/http-error.js';

// The host line guests see ("From Thandi & Sipho") and the From name on
// guest emails (where it is cut further, to 60, by email-address.util.ts).
// Counted after trimming, in characters as a person counts them (code
// points, so an emoji is one), the same way the frontend's maxLength rule
// counts. Shared by event create/update and the wizard's materialize path.
export const HOST_NAME_MAX_CHARS = 200;

export const assertValidHostName = (hostName: unknown): void => {
  if (typeof hostName !== 'string') return;
  if ([...hostName.trim()].length > HOST_NAME_MAX_CHARS) {
    throw new HttpError(422, `Keep the host name to ${HOST_NAME_MAX_CHARS} characters or fewer.`);
  }
};
