export interface CreateEventDayDto {
  label: string;
  date: string;
  startTime?: string;
  endTime?: string;
  // The day's venue — required (422 without a non-blank location and
  // address). Coordinates come from the frontend's HERE address lookup,
  // both-or-neither. See event-day-venue.util.ts.
  location: string;
  address: string;
  latitude?: number | null;
  longitude?: number | null;
}
export interface UpdateEventDayDto {
  label?: string;
  date?: string;
  startTime?: string | null;
  endTime?: string | null;
  // Omitted = keep the stored value; the day that results must still have
  // a venue name and address (422 otherwise).
  location?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
}
