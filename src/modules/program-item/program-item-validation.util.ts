import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
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
  `Choose the day '${title}' happens on — this event has more than one day.`;

export const requireItemStartTime =(startTime: unknown, title: string): Date => {
  const parsed = typeof startTime === 'string' && startTime.trim() ? parseClientDateTime(startTime.trim()) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, `'${title}' needs a start date and time.`);
  }
  return parsed;
};
