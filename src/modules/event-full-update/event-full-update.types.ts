import { type UpdateEventDto } from '../event/event.types.js';
import { type UpdateEventDayDto } from '../event-day/event-day.types.js';
import { type UpdateTicketDto } from '../ticket/ticket.types.js';
import { type UpdateRsvpFieldDto } from '../rsvp-field/rsvp-field.types.js';

// ─────────────────────────────────────────
//  PUT /api/events/:eventId/full — the wizard's edit mode, saved at once
//
//  Every list is the WHOLE list as the organiser left it: a row with an
//  `id` is a saved row (updated where it changed), a row without one is
//  new, and a saved row missing from the list is archived. A list left out
//  of the request is left alone. Each row takes the same fields as its own
//  endpoint (PUT /days/:id, /tickets/:id, /rsvp-fields/:id, /program/...).
// ─────────────────────────────────────────

// PUT /api/events/:id's own body.
export type FullUpdateEventFields = UpdateEventDto;

export interface FullUpdateDay extends UpdateEventDayDto {
  id?: string;
}

export interface FullUpdateTicket extends UpdateTicketDto {
  id?: string;
}

// `order` is the row's position in the list, whatever the row says.
export interface FullUpdateRsvpField extends Omit<UpdateRsvpFieldDto, 'order'> {
  id?: string;
}

// An item names its day by `dayIndex`, its position in this request's
// `days` (a new day has no id yet), like the wizard's materialize. Left
// out on a saved item, its stored day is kept (as PUT .../items/:id does);
// null is no day. `order` is the row's position in the list.
export interface FullUpdateProgramItem {
  id?: string;
  title?: string;
  description?: string | null;
  startTime?: string;
  durationMins?: number | null;
  dayIndex?: number | null;
}

export interface FullUpdateProgram {
  title?: string | null;
  isPublished?: boolean;
  items?: FullUpdateProgramItem[];
}

export interface FullUpdateMemoryHub {
  opensAt?: string | null;
}

export interface FullEventUpdateDto {
  event?: FullUpdateEventFields;
  days?: FullUpdateDay[];
  tickets?: FullUpdateTicket[];
  rsvpFields?: FullUpdateRsvpField[];
  program?: FullUpdateProgram;
  memoryHub?: FullUpdateMemoryHub;
}
