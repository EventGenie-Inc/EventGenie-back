import { HttpError } from '../../shared/errors/http-error.js';

// Venue capacity — a fact about the room, not a billing constraint. It
// must never be conflated with SubscriptionTierConfig.maxGuestsPerEvent
// (enforced separately in guest-tier-enforcement.util.ts) or with the
// registration cap (Event.registrationCap).
//
// It belongs to each EventDay (EventDay.capacity): an event's days can be
// at different venues. Event.capacity is deprecated and never read; a
// request that still sends it has it applied to every venue day
// (event-day/day-capacity.util.ts). A day's capacity is informational: it
// never refuses a guest, and organisers are warned when more people attend
// a day than its capacity; see day-capacity.util.ts for who counts.
//
// A whole number from 1 to 100,000: the largest stadium-sized venue an
// organiser could mean, and far below the integer column's ceiling. A
// tester's 100,000,000,000 used to pass the "positive whole number" check
// and come back from the database as a 500. The same range is a CHECK on
// EventDay.capacity (20261125090000_event_day_capacity).
export const MAX_VENUE_CAPACITY = 100_000;
export const EVENT_CAPACITY_INVALID = 'EVENT_CAPACITY_INVALID';

// `dayLabel`: the day the number is for, named in the message (a multi-day
// save says which row to fix). Without one, the event-level wording.
export const assertValidCapacity = (capacity: unknown, dayLabel?: string): void => {
  if (capacity === undefined || capacity === null) return;

  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_VENUE_CAPACITY) {
    const range = `a whole number from 1 to ${MAX_VENUE_CAPACITY.toLocaleString('en-US')}`;
    throw new HttpError(
      422,
      dayLabel ? `The venue capacity for '${dayLabel}' must be ${range}.` : `Venue capacity must be ${range}.`,
      EVENT_CAPACITY_INVALID
    );
  }
};
