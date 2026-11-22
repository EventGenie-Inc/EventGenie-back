import { type EventTicketing, type EventVisibility } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventTicketsSold } from '../ticket/ticket-sales-count.util.js';

// ─────────────────────────────────────────
//  WHO MAY MAKE AN EVENT PAID (ticket sales Round A, 2026-11)
//
//  An event becomes paid only by switching ticket sales on
//  (PUT /api/events/:eventId/ticket-sales, ticket-sales.service.ts), which
//  checks everything a paid event needs. Every other path refuses a change
//  to PAID: create, PUT /api/events/:id, the wizard's final save and the
//  full update (422 TICKET_SALES_USE_SWITCH). Re-sending the value already
//  stored still saves. Switching back to FREE through an event save is the
//  switch's own rule: refused once a ticket is sold.
//
//  Ticket sales are for public events only: a paid event can't be made
//  private, and a paid private event (possible before 2026-11) can't be
//  published (422 TICKET_SALES_PUBLIC_ONLY).
//
//  Called after the `ticketing` flag's own check (ticketing-availability.util.ts),
//  and before any plan check.
// ─────────────────────────────────────────

export const TICKET_SALES_ERROR_CODES = {
  USE_SWITCH: 'TICKET_SALES_USE_SWITCH',
  PUBLIC_ONLY: 'TICKET_SALES_PUBLIC_ONLY',
  HAVE_SALES: 'TICKET_SALES_HAVE_SALES',
  NOT_ENABLED: 'TICKET_SALES_NOT_ENABLED',
  PAYOUT_ACCOUNT_REQUIRED: 'TICKET_SALES_PAYOUT_ACCOUNT_REQUIRED',
  ACTIVE_TYPE_REQUIRED: 'TICKET_SALES_ACTIVE_TYPE_REQUIRED',
  APPROVAL_ON: 'TICKET_SALES_REGISTRATION_APPROVAL_ON',
  PLAN: 'TICKET_SALES_NOT_ON_PLAN',
  EVENT_CANCELLED: 'TICKET_SALES_EVENT_CANCELLED',
  EVENT_FINISHED: 'TICKET_SALES_EVENT_FINISHED',
  INVALID: 'TICKET_SALES_REQUEST_INVALID',
} as const;

export const USE_SWITCH_MESSAGE =
  "Ticket sales are switched on from the event's Tickets page, once it has a ticket type and your payout account is set up.";
export const PUBLIC_ONLY_MESSAGE = 'Tickets are only sold for public events. Private events stay free.';
export const HAVE_SALES_MESSAGE = "Tickets have been sold, so ticket sales can't be switched off. Pause them instead.";

// A create (or the wizard's): it can't start paid.
export const assertNotCreatedPaid = (requested: EventTicketing | string | undefined | null): void => {
  if (requested === 'PAID') throw new HttpError(422, USE_SWITCH_MESSAGE, TICKET_SALES_ERROR_CODES.USE_SWITCH);
};

// An event save (PUT /api/events/:id, the full update): FREE → PAID is the
// switch's; PAID → FREE only while nothing is sold; a paid event stays
// public. A legacy paid private event re-saved as it is stays editable.
export const assertTicketingSaveAllowed = async (
  event: { id: string; ticketing: EventTicketing; visibility: EventVisibility },
  data: { ticketing?: EventTicketing | string | null; visibility?: EventVisibility | string | null }
): Promise<void> => {
  const ticketing = data.ticketing ?? event.ticketing;
  const visibility = data.visibility ?? event.visibility;
  if (ticketing === 'PAID' && event.ticketing !== 'PAID') {
    throw new HttpError(422, USE_SWITCH_MESSAGE, TICKET_SALES_ERROR_CODES.USE_SWITCH);
  }
  if (ticketing === 'PAID' && visibility !== 'PUBLIC' && visibility !== event.visibility) {
    throw new HttpError(422, 'This event sells tickets, so it must stay public. Switch ticket sales off first.', TICKET_SALES_ERROR_CODES.PUBLIC_ONLY);
  }
  if (ticketing === 'FREE' && event.ticketing === 'PAID' && (await eventTicketsSold(event.id)) > 0) {
    throw new HttpError(409, HAVE_SALES_MESSAGE, TICKET_SALES_ERROR_CODES.HAVE_SALES);
  }
};

// Publishing: a paid event must be public.
export const assertPaidEventIsPublic = (event: { ticketing: EventTicketing; visibility: EventVisibility }): void => {
  if (event.ticketing === 'PAID' && event.visibility !== 'PUBLIC') {
    throw new HttpError(422, `${PUBLIC_ONLY_MESSAGE} Make this event public, or switch ticket sales off, before publishing it.`, TICKET_SALES_ERROR_CODES.PUBLIC_ONLY);
  }
};
