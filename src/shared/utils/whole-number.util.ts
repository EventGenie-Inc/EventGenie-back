import { HttpError } from '../errors/http-error.js';

// A numeric field where blank means something (no limit, no duration):
// null, omitted, or a blank string is "no value" and comes back as null.
// Anything else must be a whole number of 0 or more — 422 with the
// caller's message otherwise. A decimal used to reach Prisma's Int columns
// and come back as a generic 500. A numeric string is refused too: the
// frontend sends numbers, and the field's message says what to type.
export const isBlankNumberInput = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

export const optionalWholeNumber = (value: unknown, message: string): number | null => {
  if (isBlankNumberInput(value)) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HttpError(422, message);
  }
  return value;
};
