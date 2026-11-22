import { HttpError } from '../../shared/errors/http-error.js';
import { TICKET_PURCHASE_RETIRED } from '../ticket-order/ticket-order.types.js';

// ─────────────────────────────────────────
//  THE INVITATION PURCHASE PATH IS RETIRED (ticket sales Round B)
//
//  Buying a ticket through an RSVP (POST /api/rsvp/ticket-quote, an RSVP
//  submit carrying a ticketId, /api/rsvp/ticket-purchase/retry and
//  /confirm/:token) answers 410 TICKET_PURCHASE_RETIRED: tickets are sold
//  for public events only, from the event's own page (/api/ticket-orders).
//  Existing TicketPurchase rows stay as they are, readable to the organiser
//  (/api/ticket-purchases); a late Paystack success on one is still
//  recorded by the webhook. scripts/sql/ticket-purchases-check.sql lists them.
// ─────────────────────────────────────────

export const TICKET_PURCHASE_RETIRED_MESSAGE =
  "Tickets can't be bought through an invitation any more. If this event sells tickets, buy them from its public page.";

export const ticketPurchaseRetired = (): HttpError => new HttpError(410, TICKET_PURCHASE_RETIRED_MESSAGE, TICKET_PURCHASE_RETIRED);
