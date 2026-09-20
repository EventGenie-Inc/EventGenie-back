// What the guest said about THIS day — derived from the invite's overall
// answer plus its per-day RSVP rows (Attendance), never stored:
//   YES          accepted, and ticked this day
//   NO           declined, or accepted but did not tick this day
//   NO_RESPONSE  never answered
export type RsvpForDay = 'YES' | 'NO' | 'NO_RESPONSE';

export interface DayRosterRow {
  guestId: string;
  inviteId: string;
  name: string;
  // email, else phone — so two guests both showing as "Guest" (imported by
  // phone, no name yet) can still be told apart at the door.
  contact: string | null;
  isPlusOne: boolean;
  // Who a plus-one is with, so they can be found next to their host.
  hostName: string | null;
  rsvp: RsvpForDay;
  checkedIn: boolean;
  checkedInAt: string | null;
}

// All counts are PEOPLE, plus-ones included, and every one is derived from
// the same rows returned in `guests`, so the numbers can never disagree with
// the list beside them.
export interface DayRosterCounts {
  // Everyone invited to this day — the length of the list.
  invited: number;
  // Said YES to this day: the forecast "expected vs arrived" is measured against.
  expected: number;
  // Invited but never answered / said no or didn't tick this day.
  noResponse: number;
  notAttending: number;
  // Everyone checked in today, however they were expected.
  arrived: number;
  arrivedExpected: number;
  // Turned up without having said YES (non-responders, decliners, other-day
  // ticks) — the walk-ins.
  arrivedUnexpected: number;
  // Said YES and not here yet.
  stillExpected: number;
}

export interface DayRoster {
  day: { id: string; label: string; date: Date };
  counts: DayRosterCounts;
  guests: DayRosterRow[];
}

// Exactly one of the two. inviteToken is the invitation's own token — what a
// QR code on the invitation will carry — so scanning later is a second way
// to name the same guest, not a second endpoint.
export interface CheckInInput {
  guestId?: string;
  inviteToken?: string;
}

export interface CheckInResult {
  // false when the guest was already checked in for this day (see the
  // service: a repeat check-in is idempotent, not an error).
  created: boolean;
  guest: DayRosterRow;
}

export interface UndoCheckInResult {
  // false when there was nothing to undo.
  removed: boolean;
  guest: DayRosterRow | null;
}
