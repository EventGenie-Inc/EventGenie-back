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

// Every event has a host name: event create, the wizard's materialize, and
// every edit (PUT /api/events/:id and the full update). An older event saved
// without one keeps none until it is next edited; then the edit must supply
// it. Blank after trimming counts as none.
export const EVENT_HOST_NAME_REQUIRED = 'EVENT_HOST_NAME_REQUIRED';
export const EVENT_HOST_NAME_REQUIRED_MESSAGE = "Add the host's name. Guests see it on their invitation.";

export const assertHostNamePresent = (hostName: unknown): void => {
  if (typeof hostName !== 'string' || !hostName.trim()) {
    throw new HttpError(422, EVENT_HOST_NAME_REQUIRED_MESSAGE, EVENT_HOST_NAME_REQUIRED);
  }
};

// An edit: the host name the event will have once it is saved, the request's
// own when it sends one (null and '' included), else the stored one.
export const assertHostNamePresentAfterEdit = (stored: string | null, incoming: string | null | undefined): void =>
  assertHostNamePresent(incoming !== undefined ? incoming : stored);
