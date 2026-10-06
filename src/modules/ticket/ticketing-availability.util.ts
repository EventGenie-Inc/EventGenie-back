import { type EventTicketing } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

export const TICKETING_UNAVAILABLE_MESSAGE =
  "Selling tickets isn't available yet. Keep this event's ticketing as free to continue.";

// With the ticketing feature switched off, no path may turn an event's
// ticketing on: event create, update FREE -> PAID, the wizard's
// materialize, and publish (for a draft already saved as paid). An update
// that leaves an already-paid event paid passes `current` and is allowed,
// so older paid events stay editable. Called BEFORE any tier check, so a
// tenant hears this rather than an upgrade pitch for a feature that isn't
// on offer.
export const assertPaidTicketingAvailable = (
  ticketing: EventTicketing | string | undefined | null,
  current?: EventTicketing
): void => {
  if (ticketing === 'PAID' && current !== 'PAID' && !isFeatureEnabled('ticketing')) {
    throw new HttpError(422, TICKETING_UNAVAILABLE_MESSAGE);
  }
};
