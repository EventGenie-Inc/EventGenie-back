import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime, isSameUtcDate } from '../../shared/utils/date-input.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { optionalWholeNumber } from '../../shared/utils/whole-number.util.js';

// A program item needs a title and a start time — both marked required in
// the wizard. Shared by the program-item endpoints and the wizard's
// materialize path. 422: a blank title used to be saved, and a missing or
// unparseable start time reached Prisma as an Invalid Date (a generic 500).
export const requireItemTitle = (title: unknown): string => {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) throw new HttpError(422, 'Each program item needs a title, e.g. "Ceremony".');
  return trimmed;
};

// order is optional on create (defaults to the end of the list) but, when
// sent, must be a whole number of 0 or more — anything else reached Prisma
// as a generic 500.
export const assertValidItemOrder = (order: unknown): void => {
  if (order !== undefined && (typeof order !== 'number' || !Number.isInteger(order) || order < 0)) {
    throw new HttpError(422, 'A program item\'s position must be a whole number of 0 or more.');
  }
};

// durationMins is optional (blank = no duration) but, when sent, a whole
// number of minutes, 0 or more. A decimal used to reach Prisma's Int column
// as a generic 500. Same words as the wizard's rule.
export const optionalItemDuration = (durationMins: unknown, title: string): number | null =>
  optionalWholeNumber(durationMins, `Enter the duration of '${title}' in whole minutes.`);

// On an event with more than one day, every item names its day — the
// organiser UI requires it there and hides it on a single-day event, where
// a NULL item is placed by date (STEERING "Event program").
export const itemDayRequiredMessage = (title: string): string =>
  `Choose the day '${title}' happens on. This event has more than one day.`;

// The rule itself, for every path: an item with no day on an event with
// more than one live day is 422.
export const assertItemHasDay = (hasDay: boolean, liveDayCount: number, title: string): void => {
  if (!hasDay && liveDayCount > 1) throw new HttpError(422, itemDayRequiredMessage(title));
};

// An item names its day by `dayIndex`, its position in the request's own
// `days` list, where the days may not have ids yet (the wizard's
// materialize; the full event update). null/omitted is "no day". Anything
// that isn't a whole number naming one of those days is 422.
export const resolveItemDayIndex = (dayIndex: unknown, dayCount: number, title: string): number | null => {
  if (dayIndex === undefined || dayIndex === null) return null;
  if (typeof dayIndex !== 'number' || !Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= dayCount) {
    throw new HttpError(422, `'${title}' is set to a day that isn't part of this event. Choose its day again.`);
  }
  return dayIndex;
};

// ─────────────────────────────────────────
//  AN ITEM WITH A DAY STARTS ON THAT DAY
//
//  Its start time's UTC date must be the day's date (dates are UTC, see
//  STEERING "Dates"): an item filed under Saturday but starting on Sunday
//  shows guests the wrong time under the wrong day. Judged on the item a
//  change leaves behind (its day and start, stored values filling in what
//  isn't sent), and only when something about it changes: creating it, a
//  new start or day, or (in the full event update) its day's date moving.
//  An item with no day is placed by date (STEERING "Event program") and
//  has nothing to match. Every path: create, update, the wizard's
//  materialize and the full event update.
// ─────────────────────────────────────────
export const PROGRAM_ITEM_DATE_NOT_ON_DAY = 'PROGRAM_ITEM_DATE_NOT_ON_DAY';

export const assertItemStartsOnItsDay = (
  startTime: Date,
  day: { label: string; date: Date } | null,
  title: string
): void => {
  if (!day || isSameUtcDate(startTime, day.date)) return;
  throw new HttpError(
    422,
    `'${title}' is set to '${day.label}', so it must start on ${formatGuestDate(day.date)}. Change its start date or choose another day.`,
    PROGRAM_ITEM_DATE_NOT_ON_DAY
  );
};

// The program's guest visibility, when sent, is true or false, else 422
// PROGRAM_VISIBILITY_INVALID (a non-boolean used to reach Prisma as a 500
// on PUT .../program/:id). PUT .../program/:id, the wizard's materialize
// and the full event update.
export const PROGRAM_VISIBILITY_INVALID = 'PROGRAM_VISIBILITY_INVALID';

export const assertProgramVisibilityFlag = (isPublished: unknown): void => {
  if (isPublished !== undefined && typeof isPublished !== 'boolean') {
    throw new HttpError(422, 'Program visibility must be true or false.', PROGRAM_VISIBILITY_INVALID);
  }
};

export const requireItemStartTime =(startTime: unknown, title: string): Date => {
  const parsed = typeof startTime === 'string' && startTime.trim() ? parseClientDateTime(startTime.trim()) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, `'${title}' needs a start date and time.`);
  }
  return parsed;
};
