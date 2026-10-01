import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';

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

export const requireItemStartTime = (startTime: unknown, title: string): Date => {
  const parsed = typeof startTime === 'string' && startTime.trim() ? parseClientDateTime(startTime.trim()) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, `'${title}' needs a start date and time.`);
  }
  return parsed;
};
