import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
import { type EventDayLike, endOfDayUtc } from './event-status.util.js';

// ─────────────────────────────────────────
//  "RSVP BY 25 OCTOBER" MEANS UNTIL THE END OF 25 OCTOBER
//
//  An organiser picks a date, not a time. The wizard sends it as
//  `2026-10-25T23:59:59`; an API client may send `2026-10-25`, which used to
//  be stored as UTC midnight, the START of that day, and so closed replies a
//  whole day early. Both are date-only deadlines: parseDeadline stores a bare
//  date as the end of that day, and every comparison (RSVP submit, the guest
//  page's flag, reminders, registration closing, the rules below) reads a
//  stored deadline through deadlineEnd, which also covers rows written as
//  midnight before. Any other time of day is a deliberate instant and is kept
//  (an organiser closing replies "now" on a live event). Days are UTC, as
//  everywhere (STEERING "Dates"). The registration closing date follows the
//  same rule.
// ─────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const parseDeadline = (value: string): Date =>
  DATE_ONLY.test(value) ? endOfDayUtc(new Date(`${value}T00:00:00Z`)) : parseClientDateTime(value);

const isDateOnly = (d: Date): boolean => {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  return (h === 0 && m === 0 && s === 0 && d.getUTCMilliseconds() === 0) || (h === 23 && m === 59 && s === 59);
};

// The last instant replies are taken.
export const deadlineEnd = (deadline: Date): Date => (isDateOnly(deadline) ? endOfDayUtc(deadline) : deadline);

export const hasDeadlinePassed = (deadline: Date | null, now: Date = new Date()): boolean =>
  !!deadline && deadlineEnd(deadline) < now;

// The deadline is independent of Event.status (see schema comment) — this
// util only checks the deadline value itself is sane, never event.status.
export const assertValidRsvpDeadline = (
  rsvpDeadline: Date | null | undefined,
  eventDays: EventDayLike[],
  options: { rejectPast: boolean }
): void => {
  if (rsvpDeadline === undefined || rsvpDeadline === null) return;

  if (Number.isNaN(rsvpDeadline.getTime())) {
    throw new HttpError(400, "The RSVP deadline isn't a valid date.");
  }

  // Only enforced on creation (see options.rejectPast at call sites) — an
  // organiser deliberately setting a deadline to "now" on an existing
  // event to force-close RSVPs early is a legitimate action, so this is
  // not checked on update. Setting one in the past at creation time can't
  // reflect real intent (RSVPs would be closed before the event even
  // starts accepting them) and is almost always a typo. Today is not past.
  if (options.rejectPast && hasDeadlinePassed(rsvpDeadline)) {
    throw new HttpError(
      400,
      'The RSVP deadline is already in the past. Pick a future date and time, or leave it blank to accept RSVPs until the event happens.'
    );
  }

  // No event days yet (e.g. a fresh direct-POST draft) — nothing to
  // compare against. The event-day-removal edge case (archiving the day
  // that used to be "last" and stranding the deadline after the new last
  // day) is not re-validated here; see the batch report.
  if (eventDays.length === 0) return;

  // Any day up to and including the last day, whatever time that day ends:
  // a lunch ending at 14:00 can still take replies "by" its own date.
  const lastDay = eventDays.reduce((latest, day) => (day.date > latest.date ? day : latest));

  if (deadlineEnd(rsvpDeadline) > endOfDayUtc(lastDay.date)) {
    throw new HttpError(400, "The RSVP deadline can't be after the event's last day.");
  }
};
