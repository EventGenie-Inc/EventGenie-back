import { type TicketTypeStatus } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
import { endOfDayUtc } from '../event/event-status.util.js';
import { type TicketTypeInput, type TicketTypeWrite } from './ticket.types.js';

// ─────────────────────────────────────────
//  TICKET TYPE RULES (ticket sales Round A, 2026-11)
//
//  One function, resolveTicketType, for every path that writes a ticket
//  type: POST/PUT .../tickets, the full update's rows and the wizard's. It
//  merges what was sent over what is stored and, when that changes
//  anything, checks the WHOLE resulting type against every rule. A saved
//  type re-sent unchanged is never re-checked, so a type saved before these
//  rules (an R0 price, no quantity) keeps saving until it is edited.
//
//  After a sale (ticket-sales-count.util.ts), a type can't drop its quantity
//  below what is sold or change the days it admits; deleting it is refused
//  elsewhere (it can only be hidden), as is removing a day it admits.
//  A price change is fine: it applies to sales from then on (a sale keeps
//  the price it was made at).
// ─────────────────────────────────────────

// R10: the least a ticket can cost. R0 tickets aren't sold: a free event
// takes free registration instead.
export const MIN_TICKET_PRICE_CENTS = 1_000;
// R100,000: well above any real ticket, and keeps an order of 20 within
// Paystack's and the database's integer amounts.
export const MAX_TICKET_PRICE_CENTS = 10_000_000;
export const MAX_TICKET_QUANTITY = 100_000;
export const DEFAULT_MAX_PER_ORDER = 10;
export const MIN_MAX_PER_ORDER = 1;
export const MAX_MAX_PER_ORDER = 20;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_SORT_ORDER = 100_000;

export const TICKET_ERROR_CODES = {
  OLD_FIELD: 'TICKET_FIELD_RENAMED',
  NAME_REQUIRED: 'TICKET_NAME_REQUIRED',
  NAME_TOO_LONG: 'TICKET_NAME_TOO_LONG',
  DESCRIPTION_TOO_LONG: 'TICKET_DESCRIPTION_TOO_LONG',
  PRICE_INVALID: 'TICKET_PRICE_INVALID',
  PRICE_TOO_LOW: 'TICKET_PRICE_TOO_LOW',
  PRICE_TOO_HIGH: 'TICKET_PRICE_TOO_HIGH',
  CURRENCY_INVALID: 'TICKET_CURRENCY_INVALID',
  QUANTITY_REQUIRED: 'TICKET_QUANTITY_REQUIRED',
  QUANTITY_INVALID: 'TICKET_QUANTITY_INVALID',
  QUANTITY_BELOW_SOLD: 'TICKET_QUANTITY_BELOW_SOLD',
  SALES_DATE_INVALID: 'TICKET_SALES_DATE_INVALID',
  SALES_WINDOW_INVALID: 'TICKET_SALES_WINDOW_INVALID',
  SALES_END_AFTER_EVENT: 'TICKET_SALES_END_AFTER_EVENT',
  ADMITTED_DAYS_REQUIRED: 'TICKET_ADMITTED_DAYS_REQUIRED',
  ADMITTED_DAY_UNKNOWN: 'TICKET_ADMITTED_DAY_UNKNOWN',
  ADMITTED_DAYS_LOCKED: 'TICKET_ADMITTED_DAYS_LOCKED',
  MAX_PER_ORDER_INVALID: 'TICKET_MAX_PER_ORDER_INVALID',
  SORT_ORDER_INVALID: 'TICKET_SORT_ORDER_INVALID',
  STATUS_INVALID: 'TICKET_STATUS_INVALID',
  HAS_SALES: 'TICKET_TYPE_HAS_SALES',
} as const;

// A ticket type as stored, in the shape the rules compare.
export interface StoredTicketType {
  name: string;
  description: string | null;
  priceCents: number;
  totalQuantity: number | null;
  salesStart: Date | null;
  salesEnd: Date | null;
  admitsAllDays: boolean;
  admittedDayIds: string[];
  maxPerOrder: number;
  sortOrder: number;
  status: TicketTypeStatus;
}

export interface TicketRuleContext {
  // The event's live days as this save leaves them (for when sales may end).
  eventDays: { id: string; date: Date; endTime: Date | null }[];
  // The day ids a type may name in admittedDayIds; default: eventDays' ids.
  // The full update leaves out the days it creates (they have no id yet).
  admittableDayIds?: string[];
  // Tickets of this type sold so far (0 for a new type).
  sold: number;
  // A new type's sortOrder when none is sent: after the others.
  nextSortOrder: number;
}

const formatRand = (cents: number): string => `R${(cents / 100).toFixed(2)}`;

// When the event's last live day ends (its endTime, else the end of its
// date): the latest a ticket type's sales can end. null with no days.
export const lastDayEnd = (days: { date: Date; endTime: Date | null }[]): Date | null => {
  if (days.length === 0) return null;
  const last = days.reduce((latest, day) => (day.date > latest.date ? day : latest));
  return last.endTime ?? endOfDayUtc(last.date);
};

const wholeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const parseDate = (value: unknown, label: string): Date | null => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(422, `${label} must be a date and time.`, TICKET_ERROR_CODES.SALES_DATE_INVALID);
  const date = parseClientDateTime(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(422, `${label} isn't a valid date and time.`, TICKET_ERROR_CODES.SALES_DATE_INVALID);
  return date;
};

const sameDate = (a: Date | null, b: Date | null): boolean => (a?.getTime() ?? null) === (b?.getTime() ?? null);
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

// The ticket's own label for its messages ("'Saturday pass' …"), or a
// neutral one before it has a name.
const labelOf = (name: string | null): string => (name ? `'${name}'` : 'This ticket type');

export const resolveTicketType = (
  input: TicketTypeInput,
  existing: StoredTicketType | null,
  ctx: TicketRuleContext
): { write: TicketTypeWrite; changed: boolean } => {
  for (const [old, now] of [['price', 'priceCents'], ['totalQuantity', 'quantity'], ['isAvailable', 'status']] as const) {
    if (input[old] !== undefined) {
      throw new HttpError(400, `'${old}' has been replaced: send '${now}' instead.`, TICKET_ERROR_CODES.OLD_FIELD);
    }
  }
  if (input.currency !== undefined && input.currency !== 'ZAR') {
    throw new HttpError(422, 'Tickets are sold in rand (ZAR) only.', TICKET_ERROR_CODES.CURRENCY_INVALID);
  }

  // ── What the type will be ──
  let name = existing?.name ?? '';
  if (input.name !== undefined) {
    if (typeof input.name !== 'string') throw new HttpError(422, 'Each ticket type needs a name, e.g. "General admission".', TICKET_ERROR_CODES.NAME_REQUIRED);
    name = input.name.trim().replace(/\s+/g, ' ');
  }
  const label = labelOf(name || null);

  let description = existing?.description ?? null;
  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== 'string') {
      throw new HttpError(422, `${label}'s description must be text.`, TICKET_ERROR_CODES.DESCRIPTION_TOO_LONG);
    }
    description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null;
  }

  let priceCents: number | null = existing?.priceCents ?? null;
  if (input.priceCents !== undefined) {
    priceCents = wholeNumber(input.priceCents);
    if (priceCents === null) {
      throw new HttpError(422, `Enter ${label}'s price in cents, as a whole number (R150.00 is 15000).`, TICKET_ERROR_CODES.PRICE_INVALID);
    }
  }

  let totalQuantity = existing ? existing.totalQuantity : null;
  if (input.quantity !== undefined) {
    if (input.quantity === null) totalQuantity = null;
    else {
      totalQuantity = wholeNumber(input.quantity);
      if (totalQuantity === null) {
        throw new HttpError(422, `Enter how many ${label === 'This ticket type' ? 'tickets' : `${label} tickets`} there are, as a whole number.`, TICKET_ERROR_CODES.QUANTITY_INVALID);
      }
    }
  }

  const salesStart = input.salesStart !== undefined ? parseDate(input.salesStart, 'The start of ticket sales') : existing?.salesStart ?? null;
  const salesEnd = input.salesEnd !== undefined ? parseDate(input.salesEnd, 'The end of ticket sales') : existing?.salesEnd ?? null;

  let admitsAllDays = existing?.admitsAllDays ?? true;
  let admittedDayIds = existing?.admittedDayIds ?? [];
  if (input.admittedDayIds !== undefined) {
    if (input.admittedDayIds === null) {
      admitsAllDays = true;
      admittedDayIds = [];
    } else {
      if (!Array.isArray(input.admittedDayIds) || !input.admittedDayIds.every((id) => typeof id === 'string')) {
        throw new HttpError(400, 'admittedDayIds must be a list of event day ids, or null for every day.');
      }
      admitsAllDays = false;
      admittedDayIds = [...new Set(input.admittedDayIds as string[])];
    }
  }

  let maxPerOrder = existing?.maxPerOrder ?? DEFAULT_MAX_PER_ORDER;
  if (input.maxPerOrder !== undefined) {
    const parsed = wholeNumber(input.maxPerOrder);
    if (parsed === null || parsed < MIN_MAX_PER_ORDER || parsed > MAX_MAX_PER_ORDER) {
      throw new HttpError(422, `The most ${label === 'This ticket type' ? 'tickets' : `${label} tickets`} one order can have must be a whole number from ${MIN_MAX_PER_ORDER} to ${MAX_MAX_PER_ORDER}.`, TICKET_ERROR_CODES.MAX_PER_ORDER_INVALID);
    }
    maxPerOrder = parsed;
  }

  let sortOrder = existing?.sortOrder ?? ctx.nextSortOrder;
  if (input.sortOrder !== undefined) {
    const parsed = wholeNumber(input.sortOrder);
    if (parsed === null || parsed < 0 || parsed > MAX_SORT_ORDER) {
      throw new HttpError(422, `The ticket type's position must be a whole number from 0 to ${MAX_SORT_ORDER}.`, TICKET_ERROR_CODES.SORT_ORDER_INVALID);
    }
    sortOrder = parsed;
  }

  let status: TicketTypeStatus = existing?.status ?? 'ACTIVE';
  if (input.status !== undefined) {
    if (input.status !== 'ACTIVE' && input.status !== 'HIDDEN') {
      throw new HttpError(422, "A ticket type's status is ACTIVE (on sale) or HIDDEN.", TICKET_ERROR_CODES.STATUS_INVALID);
    }
    status = input.status;
  }

  const write: TicketTypeWrite = {
    name,
    description,
    priceCents: priceCents ?? 0,
    totalQuantity,
    salesStart,
    salesEnd,
    admitsAllDays,
    admittedDayIds: admitsAllDays ? [] : admittedDayIds,
    maxPerOrder,
    sortOrder,
    status,
  };

  if (existing) {
    const changed =
      write.name !== existing.name ||
      write.description !== existing.description ||
      write.priceCents !== existing.priceCents ||
      write.totalQuantity !== existing.totalQuantity ||
      !sameDate(write.salesStart, existing.salesStart) ||
      !sameDate(write.salesEnd, existing.salesEnd) ||
      write.admitsAllDays !== existing.admitsAllDays ||
      !sameSet(write.admittedDayIds, existing.admitsAllDays ? [] : existing.admittedDayIds) ||
      write.maxPerOrder !== existing.maxPerOrder ||
      write.sortOrder !== existing.sortOrder ||
      write.status !== existing.status;
    // Unchanged: saved as it is, whatever rules it predates.
    if (!changed) return { write, changed: false };
  }

  // ── Every rule, on the whole resulting type ──
  if (!write.name) throw new HttpError(422, 'Each ticket type needs a name, e.g. "General admission".', TICKET_ERROR_CODES.NAME_REQUIRED);
  if (write.name.length > MAX_NAME_LENGTH) {
    throw new HttpError(422, `A ticket type's name can be at most ${MAX_NAME_LENGTH} characters.`, TICKET_ERROR_CODES.NAME_TOO_LONG);
  }
  if (write.description && write.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new HttpError(422, `${label}'s description can be at most ${MAX_DESCRIPTION_LENGTH} characters.`, TICKET_ERROR_CODES.DESCRIPTION_TOO_LONG);
  }
  if (priceCents === null) {
    throw new HttpError(422, `${label} needs a price, in cents (R150.00 is 15000).`, TICKET_ERROR_CODES.PRICE_INVALID);
  }
  if (write.priceCents < MIN_TICKET_PRICE_CENTS) {
    throw new HttpError(
      422,
      `${label} must cost at least ${formatRand(MIN_TICKET_PRICE_CENTS)}. Tickets can't be free: for a free event, guests register instead.`,
      TICKET_ERROR_CODES.PRICE_TOO_LOW
    );
  }
  if (write.priceCents > MAX_TICKET_PRICE_CENTS) {
    throw new HttpError(422, `${label} can cost at most ${formatRand(MAX_TICKET_PRICE_CENTS)}.`, TICKET_ERROR_CODES.PRICE_TOO_HIGH);
  }
  if (write.totalQuantity === null) {
    throw new HttpError(422, `Enter how many ${label} tickets there are.`, TICKET_ERROR_CODES.QUANTITY_REQUIRED);
  }
  if (write.totalQuantity < 1 || write.totalQuantity > MAX_TICKET_QUANTITY) {
    throw new HttpError(422, `The number of ${label} tickets must be from 1 to ${MAX_TICKET_QUANTITY.toLocaleString('en-ZA')}.`, TICKET_ERROR_CODES.QUANTITY_INVALID);
  }
  if (write.totalQuantity < ctx.sold) {
    throw new HttpError(
      422,
      `${ctx.sold} ${label} ${ctx.sold === 1 ? 'ticket has' : 'tickets have'} already been sold, so there can't be fewer than ${ctx.sold}.`,
      TICKET_ERROR_CODES.QUANTITY_BELOW_SOLD
    );
  }
  if (write.salesStart && write.salesEnd && write.salesStart >= write.salesEnd) {
    throw new HttpError(422, `${label}'s sales must start before they end.`, TICKET_ERROR_CODES.SALES_WINDOW_INVALID);
  }
  const eventEnds = lastDayEnd(ctx.eventDays);
  if (write.salesEnd && eventEnds && write.salesEnd > eventEnds) {
    throw new HttpError(422, `${label}'s sales can't end after the event's last day ends.`, TICKET_ERROR_CODES.SALES_END_AFTER_EVENT);
  }
  if (!write.admitsAllDays) {
    if (write.admittedDayIds.length === 0) {
      throw new HttpError(422, `Choose at least one day ${label} admits, or let it admit every day.`, TICKET_ERROR_CODES.ADMITTED_DAYS_REQUIRED);
    }
    const liveIds = new Set(ctx.admittableDayIds ?? ctx.eventDays.map((d) => d.id));
    if (!write.admittedDayIds.every((id) => liveIds.has(id))) {
      throw new HttpError(422, `${label} can only admit days of this event.`, TICKET_ERROR_CODES.ADMITTED_DAY_UNKNOWN);
    }
  }
  if (existing && ctx.sold > 0) {
    const daysChanged =
      write.admitsAllDays !== existing.admitsAllDays ||
      !sameSet(write.admittedDayIds, existing.admitsAllDays ? [] : existing.admittedDayIds);
    if (daysChanged) {
      throw new HttpError(
        409,
        `${label} tickets have been sold, so the days it admits can't change. Hide it and add a new ticket type instead.`,
        TICKET_ERROR_CODES.ADMITTED_DAYS_LOCKED
      );
    }
  }
  return { write, changed: true };
};

// A stored ticket row (with its admitted days) in the shape the rules take.
export const toStoredTicketType = (row: {
  name: string;
  description: string | null;
  priceCents: number;
  totalQuantity: number | null;
  salesStart: Date | null;
  salesEnd: Date | null;
  admitsAllDays: boolean;
  maxPerOrder: number;
  sortOrder: number;
  status: TicketTypeStatus;
  admittedDays: { eventDayId: string }[];
}): StoredTicketType => ({
  name: row.name,
  description: row.description,
  priceCents: row.priceCents,
  totalQuantity: row.totalQuantity,
  salesStart: row.salesStart,
  salesEnd: row.salesEnd,
  admitsAllDays: row.admitsAllDays,
  admittedDayIds: row.admittedDays.map((d) => d.eventDayId),
  maxPerOrder: row.maxPerOrder,
  sortOrder: row.sortOrder,
  status: row.status,
});
