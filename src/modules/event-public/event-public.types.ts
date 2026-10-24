import { type RsvpFieldType } from '@prisma/client';

// Public self-registration — everything arrives from an unauthenticated
// POST body, so every field is checked at runtime (event-public.service.ts's
// parseRegistration) before it is trusted to be the type declared here.
export interface RegisterGuestDto {
  firstName?: unknown;
  surname?: unknown;
  // Required: the registrant's personal link is emailed, never returned.
  email?: unknown;
  phoneNumber?: unknown;
  // Multi-day events: the days they'll attend, from the days open to
  // registration. Omitted = every open day.
  dayIds?: unknown;
  // Up to the organiser's allowance for registrants
  // (Event.registrationPlusOnesAllowed).
  plusOneNames?: unknown;
  // Answers to the event's questions, exactly RSVP submit's rsvpResponses:
  // [{ rsvpFieldId, value }], ids from the view's rsvpFields.
  rsvpResponses?: unknown;
}

// Why registration isn't open. One code per state a registration page
// shows differently: cancelled (the event is off), closed (closing date or
// RSVP deadline passed, the event has happened, or no day is open to
// registration), full (the organiser's cap, or the plan's guest limit,
// which a registrant is never told about as such).
export type RegistrationClosedReason = 'CANCELLED' | 'CLOSED' | 'FULL';

// Exactly why, one per cause, so a screen can say the true reason; `reason`
// above is the coarser state the page's layout follows. NOT_PUBLISHED is the
// only "not open yet": registration has never opened.
export type RegistrationClosedCode =
  | 'EVENT_CANCELLED' // reason CANCELLED
  | 'EVENT_FINISHED' // CLOSED: the event's last day has ended
  | 'NOT_PUBLISHED' // CLOSED: a draft
  | 'CLOSING_DATE_PASSED' // CLOSED: the organiser's own closing date
  | 'RSVP_DEADLINE_PASSED' // CLOSED: no earlier closing date; the RSVP deadline
  | 'NO_DAYS_OPEN' // CLOSED: every day is closed to registration
  | 'FULL'; // FULL: the cap, the plan's guest limit or the hard ceiling

export interface RegistrationState {
  isOpen: boolean;
  reason: RegistrationClosedReason | null;
  code: RegistrationClosedCode | null;
  // Guest-facing words for `reason`; null while open.
  message: string | null;
  // When registration closes: the organiser's closing date or the RSVP
  // deadline, whichever comes first (a date-only one: the end of that day,
  // event-rsvp-deadline.util.ts). null = no closing date.
  closesAt: Date | null;
}

// GET /api/public-events/:shareToken — exactly what the registration page
// shows, built by hand in toPublicView. Nothing else about the event (no
// ids beyond each day's and each question's, which the form sends back as
// dayIds and rsvpFieldIds; no tenant, status, capacity, counts, share token
// or organiser) is ever in it.
export interface PublicEventView {
  name: string;
  hostName: string | null;
  description: string | null;
  coverImageUrl: string | null;
  days: {
    id: string;
    label: string;
    date: Date;
    startTime: Date | null;
    endTime: Date | null;
    location: string | null;
    address: string | null;
    openForRegistration: boolean;
  }[];
  // The event's questions, as the RSVP form receives them (rsvp.service.ts's
  // invitation view): the form sends answers back by id.
  rsvpFields: {
    id: string;
    label: string;
    fieldType: RsvpFieldType;
    isRequired: boolean;
    options: string | null;
  }[];
  registration: RegistrationState & {
    // What the form needs to mirror the server's own checks.
    plusOnesAllowed: number;
    allowedEmailDomains: string[];
  };
}

// One outcome: a repeat registration answers exactly as a new one does
// (event-public.service.ts's registrationAnswer), so nothing in the
// response says whether the email was already a guest.
export type RegistrationOutcome = 'REGISTERED';

// POST /api/public-events/:shareToken/register. Never the invite token:
// the link goes only to the email address, so a registration (or a
// repeat one) can't be used to read someone else's invitation.
export interface RegistrationResult {
  outcome: RegistrationOutcome;
  emailSent: boolean;
  message: string;
}
