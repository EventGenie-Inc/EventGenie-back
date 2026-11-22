// ─────────────────────────────────────────
//  CHECK-IN PASSES — request and response shapes.
// ─────────────────────────────────────────

// POST /api/rsvp/passes → { passes: GuestPassView[] }
// One per person per day, earliest day first. Guest-facing: an explicit
// allowlist, no ids beyond the day's, nothing about the plan.
export interface GuestPassView {
  // The person this code admits.
  personName: string;
  // false for the guest themselves, true for one of their plus-ones.
  isPlusOne: boolean;
  day: { id: string; label: string; date: Date };
  // The QR code's content (EV1.<passId>.<signature>); the page draws it.
  payload: string;
}

export interface GuestPassList {
  passes: GuestPassView[];
}

// POST /api/events/:eventId/check-in/scan
export interface ScanInput {
  // The day the scanner is checking people in for.
  eventDayId?: unknown;
  // Exactly what the camera read.
  payload?: unknown;
}

export type ScanColour = 'GREEN' | 'AMBER' | 'RED';

export type ScanRefusalReason =
  | 'INVALID'
  | 'INVITATION_LINK'
  | 'REVOKED'
  | 'REPLACED'
  | 'WRONG_EVENT'
  | 'WRONG_DAY'
  | 'EVENT_CANCELLED'
  | 'NOT_ALLOWED';

export interface ScanResult {
  result: ScanColour;
  // null on GREEN and AMBER.
  reason: ScanRefusalReason | null;
  // Ready to show: "Checked in", "Already checked in at 18:02 by Thabo",
  // "This code is no longer valid", …
  message: string;
  // GREEN, AMBER and WRONG_DAY; null otherwise. guestId is the person's own
  // (the plus-one's, for a plus-one): what undo takes
  // (DELETE /api/events/:eventId/check-in/days/:dayId/guests/:guestId).
  person: { guestId: string; name: string; isPlusOne: boolean; guestOf: string | null } | null;
  // GREEN and AMBER: the day checked in for. WRONG_DAY: the day the code is
  // for. null otherwise.
  day: { id: string; label: string; date: Date } | null;
  // The person's table; null until there is a seating plan.
  table: string | null;
  // AMBER (and GREEN, the time just recorded): ISO time of the check-in.
  checkedInAt: string | null;
  // AMBER: who checked them in (their username), when known.
  checkedInBy: string | null;
}
