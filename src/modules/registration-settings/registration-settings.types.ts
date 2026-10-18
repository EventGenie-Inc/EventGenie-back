import { type RegistrationState } from '../event-public/event-public.types.js';

// PUT /api/events/:eventId/registration-settings — a partial update: a key
// left out keeps what is stored. Checked field by field in the service.
export interface UpdateRegistrationSettingsDto {
  // e.g. ["company.co.za"]; [] = anyone may register.
  allowedEmailDomains?: unknown;
  // Whole number of 1 or more, or null for no cap of its own.
  cap?: unknown;
  // A client date-time, or null to close at the RSVP deadline.
  closesAt?: unknown;
  // Plus-ones each registrant may bring (0 or more).
  plusOnesAllowed?: unknown;
  // The live days open to registration — the whole list; at least one.
  openDayIds?: unknown;
}

export interface RegistrationSettingsView {
  allowedEmailDomains: string[];
  cap: number | null;
  closesAt: Date | null;
  plusOnesAllowed: number;
  days: { id: string; label: string; date: Date; openForRegistration: boolean }[];
  // Seats the cap is counting now: registrants who haven't declined, plus
  // their plus-ones.
  registeredCount: number;
  // The plan's guest limit for this event (null = unlimited); the cap can
  // never be above it.
  planGuestLimit: number | null;
  // What a registrant opening the link sees right now (closesAt in here is
  // the effective one: the closing date or the RSVP deadline, whichever is
  // first).
  registration: RegistrationState;
}
