// ─────────────────────────────────────────
//  GUEST-FACING DATES — ONE ANCHOR: UTC
//
//  Every date a guest (or an organiser reading a guest-facing message)
//  sees from this backend is formatted HERE, in UTC, and nowhere else.
//
//  Why UTC, and why it is not a compromise: the dates this product shows
//  are calendar dates an organiser PICKED — an RSVP deadline, an event day,
//  an invitation expiry — stored as "floating" wall-clock values written as
//  UTC (the wizard sends a picked date as `YYYY-MM-DDT23:59:59` with no
//  offset; see date-input.util.ts for the parse side of the same contract).
//  Reading such a value back in UTC is the identity: it prints the date
//  that was picked. Reading it in any other zone shifts it — a deadline of
//  19 Sep 23:59:59Z printed as "20 September" on a server at UTC+2 was the
//  bug this replaces. UTC is also the only anchor that does not depend on
//  how the server happens to be configured, and it is what the frontend
//  already pins to, so the SMS/email and the RSVP page agree.
//
//  The follow-up this deliberately does NOT do: events have no timezone of
//  their own, so "23:59:59" means 23:59:59 UTC for every event. Adding
//  Event.timezone later changes when a deadline INSTANT passes, not how a
//  stored date reads back — this anchor stays correct underneath it.
//
//  Do not call toLocaleDateString / getDate / getMonth etc. on a guest-facing
//  Date anywhere else: they read the server's zone.
// ─────────────────────────────────────────

// Shared guest-facing date format — a guest has no account, no context,
// and reads this in error/status messages (RSVP deadlines, invite
// expiry, Memory Hub opening dates) and in invitation/reminder emails.
export const formatGuestDate = (date: Date): string =>
  date.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

// "20 Sep" — for SMS, where every character costs money. No year, and no
// zero-padding (en-ZA's own short format pads the day).
export const formatGuestDateShort = (date: Date): string =>
  `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}`;

// The date of the first day of an event, as a guest-facing label; null when
// the event has no days yet.
export const formatEarliestDay = (eventDays: { date: Date }[]): string | null => {
  if (!eventDays.length) return null;
  const earliest = eventDays.reduce((a, b) => (a.date < b.date ? a : b));
  return formatGuestDate(earliest.date);
};
