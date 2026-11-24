// POST /api/events/:id/duplicate — arrives as unknown JSON and is narrowed
// by event-duplicate.service.ts's parseDuplicateRequest, never trusted.
export interface DuplicateEventDto {
  name: string;
  // The copy's first day, a calendar date (YYYY-MM-DD, or a date-time whose
  // date is used). Later days keep their spacing from it.
  firstDate: string;
  // Off by default.
  copyGuests?: boolean;
}

// What the engine is told, after the request is checked.
export interface DuplicateOptions {
  name: string;
  firstDate: Date; // UTC midnight
  copyGuests: boolean;
}

// The date fields that moved into the past with the shift and were left
// empty on the copy instead (an empty RSVP deadline takes replies until the
// event; an empty registration closing date closes at the RSVP deadline).
export type ClearedDateField = 'rsvpDeadline' | 'registrationClosesAt';

// Returned beside the copy (as `duplication` on the response), so the
// organiser can be told what came across.
export interface DuplicationSummary {
  sourceEventId: string;
  // Whole days the copy's dates moved by (0 for an event with no days).
  shiftDays: number;
  coverCopied: boolean;
  designCopied: boolean;
  // The source had a file of ours that was already gone (purged after
  // archiving, say): the copy has none.
  coverMissing: boolean;
  designMissing: boolean;
  // A CANVAS design not copied because the copy's plan has no
  // invitationDesignsEnabled (the copy has the default instead).
  designNotOnPlan: boolean;
  guestsCopied: number;
  clearedDates: ClearedDateField[];
}

export const DUPLICATE_ERROR_CODES = {
  // firstDate missing or not a date. 422.
  DATE_INVALID: 'DUPLICATE_EVENT_DATE_INVALID',
  // copyGuests on a public event: a public event's guests registered
  // themselves, and nobody is registered for the copy on their behalf. 422.
  GUESTS_PUBLIC_EVENT: 'DUPLICATE_EVENT_GUESTS_PUBLIC_EVENT',
  // A granted event (custom tiers) carries no guests and sells no tickets:
  // the template must be free. 422.
  GRANT_NOT_COPYABLE: 'GRANTED_EVENT_TEMPLATE_NOT_COPYABLE',
} as const;
