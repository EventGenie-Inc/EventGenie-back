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
//  EventDay.latitude/longitude (and, until they were dropped, the Event's
//  own) are Prisma Decimal(10, 7) columns. On read
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
type DecimalCoordinates = { latitude: Prisma.Decimal | null; longitude: Prisma.Decimal | null };
type PlainCoordinates<T extends DecimalCoordinates> = Omit<T, 'latitude' | 'longitude'> & {
  latitude: number | null;
  longitude: number | null;
};

// One row — an EventDay (which carries its own venue coordinates since the
// venue moved to the day) or anything else with the same two columns.
export const withPlainDayCoordinates = <T extends DecimalCoordinates>(row: T): PlainCoordinates<T> => ({
  ...row,
  latitude: row.latitude === null ? null : Number(row.latitude),
  longitude: row.longitude === null ? null : Number(row.longitude),
});

type PlainEvent<T> = Omit<T, 'eventDays'> &
  (T extends { eventDays: (infer D)[] }
    ? { eventDays: D extends DecimalCoordinates ? PlainCoordinates<D>[] : D[] }
    : unknown);

// An Event row's eventDays, when they were included — the day venue
// columns are Decimal, and every event response that carries days would
// otherwise leak them as strings exactly as described above. The Event row
// itself has no coordinates since its venue columns were dropped
// (20261004090000_drop_event_venue_columns), so it passes through as is.
export const withPlainCoordinates = <T extends object>(event: T): PlainEvent<T> => {
  const days = (event as { eventDays?: DecimalCoordinates[] }).eventDays;
  return {
    ...event,
    ...(days ? { eventDays: days.map(withPlainDayCoordinates) } : {}),
  } as unknown as PlainEvent<T>;
};
