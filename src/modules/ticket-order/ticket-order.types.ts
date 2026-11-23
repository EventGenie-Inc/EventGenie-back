import { type IssuedTicketStatus, type TicketOrderStatus } from '@prisma/client';

// ─────────────────────────────────────────
//  TICKET ORDERS (ticket sales Round B; STEERING "Ticket sales")
//
//  Every field from a public request is checked at runtime
//  (ticket-order.service.ts's parseCheckout) before it is trusted.
// ─────────────────────────────────────────

// POST /api/ticket-orders/checkout
export interface CheckoutInput {
  shareToken?: unknown;
  items?: unknown; // [{ ticketTypeId, quantity }]
  buyer?: unknown; // { name, email, phone?, phoneCountry? }
  termsAccepted?: unknown; // true
  idempotencyKey?: unknown; // the client's own, 16 to 100 characters
}

export const MAX_TICKETS_PER_ORDER = 20;
export const ORDER_HOLD_MINUTES = 30;

// Every refusal a buyer can meet, by code. The page lays out by these; the
// message is the buyer's own words (no plan, tier or organiser language).
export const TICKET_ORDER_CODES = {
  REQUEST_INVALID: 'TICKET_ORDER_REQUEST_INVALID',
  EVENT_NOT_FOUND: 'TICKET_ORDER_EVENT_NOT_FOUND',
  NOT_ON_SALE: 'TICKET_ORDER_NOT_ON_SALE',
  EVENT_CANCELLED: 'TICKET_ORDER_EVENT_CANCELLED',
  EVENT_ENDED: 'TICKET_ORDER_EVENT_ENDED',
  SALES_PAUSED: 'TICKET_ORDER_SALES_PAUSED',
  TYPE_UNAVAILABLE: 'TICKET_ORDER_TYPE_UNAVAILABLE',
  TYPE_NOT_YET_ON_SALE: 'TICKET_ORDER_TYPE_NOT_YET_ON_SALE',
  TYPE_SALES_ENDED: 'TICKET_ORDER_TYPE_SALES_ENDED',
  TOO_MANY_OF_TYPE: 'TICKET_ORDER_TOO_MANY_OF_TYPE',
  TOO_MANY_TICKETS: 'TICKET_ORDER_TOO_MANY_TICKETS',
  NOT_ENOUGH_LEFT: 'TICKET_ORDER_NOT_ENOUGH_LEFT',
  // A day the order's tickets admit has no room (its venue capacity):
  // details { eventDayId, dayLabel, remaining, days: [every short day] }.
  DAY_FULL: 'TICKET_ORDER_DAY_FULL',
  BUYER_NAME_REQUIRED: 'TICKET_ORDER_BUYER_NAME_REQUIRED',
  BUYER_EMAIL_INVALID: 'TICKET_ORDER_BUYER_EMAIL_INVALID',
  TERMS_REQUIRED: 'TICKET_ORDER_TERMS_REQUIRED',
  PAYMENTS_UNAVAILABLE: 'TICKET_ORDER_PAYMENTS_UNAVAILABLE',
  ORDER_NOT_FOUND: 'TICKET_ORDER_NOT_FOUND',
  RETRY_NOT_ALLOWED: 'TICKET_ORDER_RETRY_NOT_ALLOWED',
  IN_PROGRESS: 'TICKET_ORDER_IN_PROGRESS',
} as const;

export interface OrderDayView {
  id: string;
  label: string;
  date: Date;
  startTime: Date | null;
  endTime: Date | null;
  locationType: 'VENUE' | 'ONLINE';
  location: string | null;
  address: string | null;
  // An online day's meeting link: the buyer is a confirmed guest. Only on a
  // PAID order's view.
  onlineUrl: string | null;
}

export interface OrderTicketView {
  id: string;
  number: string;
  typeName: string;
  // "Ticket 2 of 3"
  label: string;
  status: IssuedTicketStatus;
  days: OrderDayView[];
  // The QR's content (EVT1.…), only for a VALID ticket that admits at least
  // one venue day; null otherwise (an online-only ticket has no QR).
  payload: string | null;
}

// POST /api/ticket-orders/status, the checkout's answer and the retry's.
export interface OrderView {
  orderId: string;
  status: TicketOrderStatus;
  event: { name: string; hostName: string | null };
  buyer: { name: string; email: string; phone: string | null };
  items: { ticketTypeId: string; typeName: string; quantity: number; unitPriceCents: number }[];
  amounts: {
    subtotalCents: number;
    commissionCents: number;
    platformFixedFeeCents: number;
    processingFeeCents: number;
    feesCents: number;
    totalCents: number;
    currency: string;
  };
  // While PENDING and the hold lasts: where to pay. Otherwise null.
  authorizationUrl: string | null;
  holdExpiresAt: Date | null;
  // PAID (and a chargeback still open): the tickets. Otherwise [].
  tickets: OrderTicketView[];
}

export interface CheckoutResult extends OrderView {
  // Keep it: it opens this order (POST /status), in the body or a fragment,
  // never a path. Null when the checkout was matched by the same buyer and
  // items (not the client's own key): the tickets will be emailed.
  orderToken: string | null;
  reused: boolean;
}

// The retired invitation purchase path (ticket sales Round B).
export const TICKET_PURCHASE_RETIRED = 'TICKET_PURCHASE_RETIRED';
