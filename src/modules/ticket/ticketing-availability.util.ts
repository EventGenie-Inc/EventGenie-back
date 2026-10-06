import { type EventTicketing } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

export const TICKETING_UNAVAILABLE_MESSAGE =
  "Selling tickets isn't available yet. Keep this event's ticketing as free to continue.";

// With the ticketing feature switched off, no path may turn an event's
// ticketing on: event create and update, the wizard's materialize, and
// publish (for an event already saved as paid). Called BEFORE any tier
// check, so a tenant hears this rather than an upgrade pitch for a
// feature that isn't on offer.
export const assertPaidTicketingAvailable = (ticketing: EventTicketing | string | undefined | null): void => {
  if (ticketing === 'PAID' && !isFeatureEnabled('ticketing')) {
    throw new HttpError(422, TICKETING_UNAVAILABLE_MESSAGE);
  }
};
