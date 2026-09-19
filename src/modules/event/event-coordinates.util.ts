import { type Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';

const isPlausibleLatitude = (value: number): boolean =>
  Number.isFinite(value) && value >= -90 && value <= 90;

const isPlausibleLongitude = (value: number): boolean =>
  Number.isFinite(value) && value >= -180 && value <= 180;

// Coordinates are optional on an Event — an organiser may type an address
// that doesn't resolve, or skip search entirely, and the event still
// saves. But a HALF-set pair is worse than none: it won't error anywhere,
// it will just silently produce wrong distances wherever proximity search
// reads it later. So the rule is strictly both-or-neither, checked on
// every create/update path (direct POST, PUT, and the wizard's
// materialize path in event-draft.service.ts).
export const assertValidCoordinates = (
  latitude: number | null | undefined,
  longitude: number | null | undefined
): void => {
  const hasLatitude = latitude !== undefined && latitude !== null;
  const hasLongitude = longitude !== undefined && longitude !== null;

  if (!hasLatitude && !hasLongitude) return;

  if (hasLatitude !== hasLongitude) {
    throw new HttpError(
      400,
      'Both latitude and longitude must be provided together, or neither — a single coordinate cannot be saved on its own.'
    );
  }

  if (!isPlausibleLatitude(latitude as number)) {
    throw new HttpError(400, `'${latitude}' is not a valid latitude — it must be a number between -90 and 90.`);
  }

  if (!isPlausibleLongitude(longitude as number)) {
    throw new HttpError(400, `'${longitude}' is not a valid longitude — it must be a number between -180 and 180.`);
  }
};

// ─────────────────────────────────────────
//  DECIMAL -> NUMBER, at the repository boundary
//
//  Event.latitude/longitude are Prisma Decimal(10, 7) columns. On read
//  they arrive as Decimal instances, which JSON.stringify (via Decimal's
//  own toJSON) renders as STRINGS — so the API told clients
//  `"latitude": "-26.19432"` while its own contract (and the frontend's
//  EventDetail model) says number. The frontend loaded that string into
//  the edit form untouched and sent it straight back on save, where
//  assertValidCoordinates above (correctly) refused it: "'-26.19432' is
//  not a valid latitude". Re-typing the address replaced the strings
//  with real numbers from the geocoder, which is why that worked around
//  it. Same trap already documented for Ticket.price and
//  TicketPurchase.totalPaid, and already fixed for
//  VendorSpace.latitude/longitude (vendor.repository.ts's
//  withPlainCoords).
//
//  Fixed HERE — converted once, in eventRepository, so every caller (the
//  JSON response, event-scoped vendor proximity, anything later) always
//  sees a plain number — rather than loosening assertValidCoordinates to
//  accept strings (which would bury the wrong type instead of fixing it)
//  or coercing in one frontend form (which would leave every other
//  consumer to rediscover it). Number(decimal) is the same coercion
//  vendor.repository.ts uses; 7 decimal places are well inside a double's
//  precision.
// ─────────────────────────────────────────
export const withPlainCoordinates = <T extends { latitude: Prisma.Decimal | null; longitude: Prisma.Decimal | null }>(
  event: T
): Omit<T, 'latitude' | 'longitude'> & { latitude: number | null; longitude: number | null } => ({
  ...event,
  latitude: event.latitude === null ? null : Number(event.latitude),
  longitude: event.longitude === null ? null : Number(event.longitude),
});
