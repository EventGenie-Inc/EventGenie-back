import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';

// The Memory Hub's opening time (`opensAt`): a client date-time string,
// null (or '') for "open now", or left out. Anything else, or a string
// that isn't a date, is 422 MEMORY_HUB_OPENS_AT_INVALID: it used to reach
// Prisma as an Invalid Date and come back a 500. Every path that sets it:
// POST and PUT .../memory-hub, the wizard's materialize and the full event
// update. Organiser-facing, so it says "Memory Hub".
export const MEMORY_HUB_OPENS_AT_INVALID = 'MEMORY_HUB_OPENS_AT_INVALID';

export const assertValidOpensAt = (opensAt: unknown): void => {
  if (opensAt === undefined || opensAt === null) return;
  // '' is "open now" (the repositories store a falsy value as null); any
  // other string is parsed exactly as the repositories will parse it.
  if (typeof opensAt === 'string' && (opensAt === '' || !Number.isNaN(parseClientDateTime(opensAt).getTime()))) return;
  throw new HttpError(422, "The Memory Hub's opening time isn't a valid date and time.", MEMORY_HUB_OPENS_AT_INVALID);
};
