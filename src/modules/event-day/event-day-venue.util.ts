import { type EventDayLocationType, type Prisma } from '@prisma/client';
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
//  (event-day.service.ts, the wizard's materialize in event-draft.service.ts
//  and the full update) goes through here, so a day can never be SAVED
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
//
//  ONLINE. A day can instead happen online (locationType ONLINE, an
//  online chess tournament, say): no venue name, address or coordinates
//  (stored null, whatever is sent), and an optional link (onlineUrl),
//  https only, for where it happens. A VENUE day never keeps a link. Left
//  out, a new day is a VENUE and a saved one keeps its type; a day saved
//  before ONLINE existed (null) is a VENUE. Switching an online day back to
//  a venue needs a venue name and address like any VENUE day.
//
//  WHO SEES THE LINK. Only people invited or registered: the guest's own
//  invitation (/rsvp/validate, the Program tab), and the invitation,
//  reminder and registration emails. Never the public registration page.
//  Every guest-facing place shows an online day's venue as "Online"
//  (ONLINE_VENUE_LABEL), with no address and no map (toDayVenueView).
// ─────────────────────────────────────────

export const ONLINE_VENUE_LABEL = 'Online';

// 422 codes, so the day editor marks the right control.
export const EVENT_DAY_LOCATION_TYPE_INVALID = 'EVENT_DAY_LOCATION_TYPE_INVALID';
export const EVENT_DAY_ONLINE_URL_INVALID = 'EVENT_DAY_ONLINE_URL_INVALID';

export const MAX_ONLINE_URL_LENGTH = 2000;

export interface DayVenueInput {
  location?: unknown;
  address?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  locationType?: unknown;
  onlineUrl?: unknown;
}

export interface DayVenue {
  locationType: EventDayLocationType;
  location: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  onlineUrl: string | null;
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

const resolveLocationType = (value: unknown, fallback: EventDayLocationType, label: unknown): EventDayLocationType => {
  if (value === undefined || value === null) return fallback;
  if (value !== 'VENUE' && value !== 'ONLINE') {
    throw new HttpError(422, `Choose whether ${dayName(label)} happens at a venue or online.`, EVENT_DAY_LOCATION_TYPE_INVALID);
  }
  return value;
};

// An online day's link: blank or null is none; else a full https:// URL
// with a host and no user name or password in it, at most
// MAX_ONLINE_URL_LENGTH characters. Never http, javascript:, mailto: or a
// bare domain: it goes into guests' emails and pages as a link.
export const resolveOnlineUrl = (value: unknown, label: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const refuse = (): never => {
    throw new HttpError(
      422,
      `The link for ${dayName(label)} must be a full https:// address, like https://example.com/tournament.`,
      EVENT_DAY_ONLINE_URL_INVALID
    );
  };
  if (typeof value !== 'string') return refuse();
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_ONLINE_URL_LENGTH || /\s/.test(trimmed)) return refuse();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return refuse();
  }
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password) return refuse();
  return trimmed;
};

const onlineVenue = (onlineUrl: string | null): DayVenue => ({
  locationType: 'ONLINE',
  location: null,
  address: null,
  latitude: null,
  longitude: null,
  onlineUrl,
});

export const resolveDayVenueForCreate = (data: DayVenueInput, label?: unknown): DayVenue => {
  const locationType = resolveLocationType(data.locationType, 'VENUE', label);
  if (locationType === 'ONLINE') return onlineVenue(resolveOnlineUrl(data.onlineUrl, label));

  const location = requiredText(data.location, 'name', label);
  const address = requiredText(data.address, 'address', label);
  const latitude = coordinate(data.latitude) ?? null;
  const longitude = coordinate(data.longitude) ?? null;
  assertValidCoordinates(latitude, longitude);
  return { locationType, location, address, latitude, longitude, onlineUrl: null };
};

export interface StoredDayVenue {
  location: string | null;
  address: string | null;
  latitude: Prisma.Decimal | number | null;
  longitude: Prisma.Decimal | number | null;
  locationType: EventDayLocationType | null;
  onlineUrl: string | null;
}

// A partial update is judged on the day it LEAVES behind, not on the
// request alone: omitting location/address keeps the stored value, and
// the result must still have both. So an old day that came out of the
// migration with no venue (its event had none) can still be renamed —
// but only once a venue is supplied with it. An online day left online
// keeps its link unless one is sent (null or blank removes it).
export const resolveDayVenueForUpdate = (data: DayVenueInput, existing: StoredDayVenue, label: string): DayVenue => {
  const storedType = existing.locationType ?? 'VENUE';
  const locationType = resolveLocationType(data.locationType, storedType, label);
  if (locationType === 'ONLINE') {
    const onlineUrl = data.onlineUrl !== undefined
      ? resolveOnlineUrl(data.onlineUrl, label)
      : storedType === 'ONLINE' ? existing.onlineUrl : null;
    return onlineVenue(onlineUrl);
  }

  const location = requiredText(data.location !== undefined ? data.location : existing.location, 'name', label);
  const address = requiredText(data.address !== undefined ? data.address : existing.address, 'address', label);

  const coordinatesSent = data.latitude !== undefined || data.longitude !== undefined;
  if (coordinatesSent) {
    const latitude = coordinate(data.latitude) ?? null;
    const longitude = coordinate(data.longitude) ?? null;
    assertValidCoordinates(latitude, longitude);
    return { locationType, location, address, latitude, longitude, onlineUrl: null };
  }

  if (address !== existing.address) {
    return { locationType, location, address, latitude: null, longitude: null, onlineUrl: null };
  }
  return {
    locationType,
    location,
    address,
    latitude: existing.latitude === null ? null : Number(existing.latitude),
    longitude: existing.longitude === null ? null : Number(existing.longitude),
    onlineUrl: null,
  };
};

// Whether a saved day has somewhere to be: a venue name and address, or
// online (publishing refuses a day with neither).
export const dayHasVenue = (day: { locationType: EventDayLocationType | null; location: string | null; address: string | null }): boolean =>
  day.locationType === 'ONLINE' || (!!day.location?.trim() && !!day.address?.trim());

// The venue a guest or organiser is shown for one day — plain numbers,
// never Prisma Decimals (see event-coordinates.util.ts on why a Decimal
// must not reach JSON). An online day reads "Online", with no address and
// no coordinates, so nothing draws a map or offers an address search.
// `onlineUrl` only with { withOnlineUrl: true }: for people invited or
// registered (and organisers), never the public page.
export const toDayVenueView = (
  day: {
    location: string | null;
    address: string | null;
    latitude: Prisma.Decimal | number | null;
    longitude: Prisma.Decimal | number | null;
    locationType?: EventDayLocationType | null;
    onlineUrl?: string | null;
  },
  options: { withOnlineUrl: boolean } = { withOnlineUrl: false }
) => {
  const online = day.locationType === 'ONLINE';
  return {
    locationType: online ? ('ONLINE' as const) : ('VENUE' as const),
    location: online ? ONLINE_VENUE_LABEL : day.location,
    address: online ? null : day.address,
    latitude: online || day.latitude === null || day.latitude === undefined ? null : Number(day.latitude),
    longitude: online || day.longitude === null || day.longitude === undefined ? null : Number(day.longitude),
    ...(options.withOnlineUrl && { onlineUrl: online ? (day.onlineUrl ?? null) : null }),
  };
};
