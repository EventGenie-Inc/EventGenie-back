import { HttpError } from '../../shared/errors/http-error.js';
import { optionalWholeNumber } from '../../shared/utils/whole-number.util.js';

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

// totalQuantity: blank means unlimited; otherwise a whole number of 0 or
// more. A decimal reached Prisma's Int column as a generic 500. Shared with
// the wizard's materialize path, same words as the wizard's rule.
export const optionalTicketQuantity = (totalQuantity: unknown, name: string): number | null =>
  optionalWholeNumber(totalQuantity, `Enter a whole number of tickets for '${name}', or leave it blank for unlimited.`);

export interface TicketInput {
  name?: unknown;
  description?: unknown;
  price?: unknown;
  currency?: unknown;
  totalQuantity?: unknown;
}

// Every rule for a NEW ticket type (POST .../tickets and the full event
// update; the wizard's materialize applies the same three helpers).
export const resolveNewTicket = (data: TicketInput) => {
  const name = requireTicketName(data.name);
  return { name, price: requireTicketPrice(data.price, name), totalQuantity: optionalTicketQuantity(data.totalQuantity, name) };
};

// Every rule for a change to a saved ticket type, omitted fields kept
// (PUT .../tickets/:id and the full event update).
export const resolveTicketChanges = (data: TicketInput, existing: { name: string }) => {
  const name = data.name !== undefined ? requireTicketName(data.name) : undefined;
  const price = data.price !== undefined ? requireTicketPrice(data.price, name ?? existing.name) : undefined;
  const totalQuantity = data.totalQuantity !== undefined ? optionalTicketQuantity(data.totalQuantity, name ?? existing.name) : undefined;
  return {
    ...(name !== undefined && { name }),
    ...(price !== undefined && { price }),
    ...(totalQuantity !== undefined && { totalQuantity }),
  };
};
