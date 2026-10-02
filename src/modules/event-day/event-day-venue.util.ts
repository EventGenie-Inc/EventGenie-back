import { type Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertValidCoordinates } from '../event/event-coordinates.util.js';

// ─────────────────────────────────────────
//  THE VENUE BELONGS TO THE EVENT DAY
//
//  Every EventDay carries its own venue — a ceremony and the next
//  morning's brunch are often in different places — and the event-level
//  venue is retired (schema.prisma's comment on Event.location). The
//  columns are nullable only so the migration that introduced them could
//  run on old events with no venue to copy; every create and update path
//  (event-day.service.ts, and the wizard's materialize in
//  event-draft.service.ts) goes through here, so a day can never be SAVED
//  without a venue name and address from now on.
//
//  Coordinates work exactly as the event-level ones did: the frontend's
//  address search resolves the address through HERE (geocoding.router.ts)
//  and sends latitude/longitude with it. This backend never calls HERE on
//  save — a HERE outage must never block an organiser from saving a day.
//  Both-or-neither, plausible range (assertValidCoordinates). One rule is
//  new, because a day's address is edited on its own: an address that
//  CHANGES without fresh coordinates clears the old ones, rather than
//  leaving a map pin on the previous venue.
// ─────────────────────────────────────────

export interface DayVenueInput {
  location?: unknown;
  address?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

export interface DayVenue {
  location: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

const dayName = (label: unknown): string =>
  typeof label === 'string' && label.trim() ? `'${label.trim()}'` : 'Each day';

const requiredText = (value: unknown, what: string, label: unknown): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new HttpError(422, `${dayName(label)} needs a venue ${what}. Every event day has its own venue.`);
  }
  return trimmed;
};

// Coordinates arrive as JSON numbers from the address search, or null to
// clear. Anything else goes to assertValidCoordinates as-is, which refuses
// it with the same message the event-level fields always gave.
const coordinate = (value: unknown): number | null | undefined =>
  value === undefined || value === null ? (value as null | undefined) : (value as number);

export const resolveDayVenueForCreate = (data: DayVenueInput, label?: unknown): DayVenue => {
  const location = requiredText(data.location, 'name', label);
  const address = requiredText(data.address, 'address', label);
  const latitude = coordinate(data.latitude) ?? null;
  const longitude = coordinate(data.longitude) ?? null;
  assertValidCoordinates(latitude, longitude);
  return { location, address, latitude, longitude };
};

// A partial update is judged on the day it LEAVES behind, not on the
// request alone: omitting location/address keeps the stored value, and
// the result must still have both. So an old day that came out of the
// migration with no venue (its event had none) can still be renamed —
// but only once a venue is supplied with it.
export const resolveDayVenueForUpdate = (
  data: DayVenueInput,
  existing: { location: string | null; address: string | null; latitude: Prisma.Decimal | number | null; longitude: Prisma.Decimal | number | null },
  label: string
): DayVenue => {
  const location = requiredText(data.location !== undefined ? data.location : existing.location, 'name', label);
  const address = requiredText(data.address !== undefined ? data.address : existing.address, 'address', label);

  const coordinatesSent = data.latitude !== undefined || data.longitude !== undefined;
  if (coordinatesSent) {
    const latitude = coordinate(data.latitude) ?? null;
    const longitude = coordinate(data.longitude) ?? null;
    assertValidCoordinates(latitude, longitude);
    return { location, address, latitude, longitude };
  }

  if (address !== existing.address) {
    return { location, address, latitude: null, longitude: null };
  }
  return {
    location,
    address,
    latitude: existing.latitude === null ? null : Number(existing.latitude),
    longitude: existing.longitude === null ? null : Number(existing.longitude),
  };
};

// The venue a guest or organiser is shown for one day — plain numbers,
// never Prisma Decimals (see event-coordinates.util.ts on why a Decimal
// must not reach JSON).
export const toDayVenueView = (day: {
  location: string | null;
  address: string | null;
  latitude: Prisma.Decimal | number | null;
  longitude: Prisma.Decimal | number | null;
}) => ({
  location: day.location,
  address: day.address,
  latitude: day.latitude === null ? null : Number(day.latitude),
  longitude: day.longitude === null ? null : Number(day.longitude),
});
