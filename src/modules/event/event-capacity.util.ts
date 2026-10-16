import { HttpError } from '../../shared/errors/http-error.js';

// Event.capacity is the VENUE's physical capacity — a fact about the
// room, not a billing constraint. It must never be conflated with
// SubscriptionTierConfig.maxGuestsPerEvent (enforced separately in
// guest-tier-enforcement.util.ts, which still blocks). Capacity itself
// never blocks anything — it only informs, via acceptedGuestCount on the
// event detail response — so this only validates the number is sane.
//
// A whole number from 1 to 100,000: the largest stadium-sized venue an
// organiser could mean, and far below the integer column's ceiling. A
// tester's 100,000,000,000 used to pass the "positive whole number" check
// and come back from the database as a 500.
export const MAX_VENUE_CAPACITY = 100_000;
export const EVENT_CAPACITY_INVALID = 'EVENT_CAPACITY_INVALID';

export const assertValidCapacity = (capacity: unknown): void => {
  if (capacity === undefined || capacity === null) return;

  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_VENUE_CAPACITY) {
    throw new HttpError(
      422,
      `Venue capacity must be a whole number from 1 to ${MAX_VENUE_CAPACITY.toLocaleString('en-US')}.`,
      EVENT_CAPACITY_INVALID
    );
  }
};
