import { type EventDayLocationType } from '@prisma/client';

export interface CreateEventDayDto {
  label: string;
  date: string;
  startTime?: string;
  endTime?: string;
  // VENUE (the default) or ONLINE. See event-day-venue.util.ts.
  locationType?: EventDayLocationType;
  // A VENUE day's venue — required (422 without a non-blank location and
  // address). Coordinates come from the frontend's HERE address lookup,
  // both-or-neither. Ignored for an ONLINE day.
  location?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  // An ONLINE day's optional link, https only (422
  // EVENT_DAY_ONLINE_URL_INVALID). Ignored for a VENUE day.
  onlineUrl?: string | null;
}
export interface UpdateEventDayDto {
  label?: string;
  date?: string;
  startTime?: string | null;
  endTime?: string | null;
  // Omitted = keep the stored value; the day that results must still have
  // a venue name and address (422 otherwise), unless it is ONLINE.
  locationType?: EventDayLocationType;
  location?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  onlineUrl?: string | null;
}
