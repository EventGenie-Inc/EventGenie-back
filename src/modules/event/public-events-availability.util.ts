import { type EventVisibility } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

export const PUBLIC_EVENTS_UNAVAILABLE_MESSAGE =
  "Public events aren't available yet. Keep this event private to continue.";

// With the publicEvents feature switched off, no path may make an event
// PUBLIC: event create, update PRIVATE -> PUBLIC, the wizard's
// materialize, and publish (for a draft already saved as public). An
// update that leaves an already-public event public passes `current` and
// is allowed. Called BEFORE any tier check, like
// assertPaidTicketingAvailable, so a tenant never hears an upgrade pitch
// for a feature that isn't on offer.
export const assertPublicEventsAvailable = (
  visibility: EventVisibility | string | undefined | null,
  current?: EventVisibility
): void => {
  if (visibility === 'PUBLIC' && current !== 'PUBLIC' && !isFeatureEnabled('publicEvents')) {
    throw new HttpError(422, PUBLIC_EVENTS_UNAVAILABLE_MESSAGE);
  }
};
