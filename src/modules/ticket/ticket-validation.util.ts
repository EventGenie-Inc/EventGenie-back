import { HttpError } from '../../shared/errors/http-error.js';

// Required ticket fields — the wizard marks name and price required. Shared
// by the ticket endpoints and the wizard's materialize path so both refuse
// the same blanks with the same words. 422: well-formed, but missing what
// an organiser has to fill in (a blank name used to be saved; a missing
// price reached Prisma and came back as a generic 500).
export const requireTicketName = (name: unknown): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new HttpError(422, 'Each ticket type needs a name, e.g. "General admission".');
  return trimmed;
};

export const requireTicketPrice = (price: unknown, name: string): number => {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    throw new HttpError(422, `'${name}' needs a price of 0 or more.`);
  }
  return price;
};
