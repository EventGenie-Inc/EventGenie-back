import { type TicketTypeStatus } from '@prisma/client';

// ─────────────────────────────────────────
//  TICKET TYPES (ticket sales Round A, 2026-11; STEERING "Ticket sales")
//
//  POST /api/events/:eventId/tickets, PUT .../tickets/:id, the full update's
//  `tickets` rows and the wizard's. Every field arrives from a request body,
//  so each is checked at runtime (ticket-validation.util.ts). Money is
//  integer cents everywhere; the old decimal `price` is refused.
// ─────────────────────────────────────────

export interface TicketTypeInput {
  name?: unknown;
  description?: unknown; // string, or null to clear
  priceCents?: unknown; // whole cents, at least MIN_TICKET_PRICE_CENTS
  quantity?: unknown; // whole number, 1 or more; required for a new type
  salesStart?: unknown; // "2027-03-02T18:00", South African time, or null
  salesEnd?: unknown; // the same, or null; not after the event's last day ends
  admittedDayIds?: unknown; // null = every day of the event; else at least one of its live day ids
  maxPerOrder?: unknown; // 1 to 20; default 10
  sortOrder?: unknown; // whole number; default: after the others
  status?: unknown; // 'ACTIVE' | 'HIDDEN'; default ACTIVE
  currency?: unknown; // 'ZAR' only, if sent
  // Refused if sent (400): the pre-2026-11 names.
  price?: unknown;
  totalQuantity?: unknown;
  isAvailable?: unknown;
}

// What a create or a change writes (ticket.repository.ts).
export interface TicketTypeWrite {
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

// The organiser's view of a ticket type: an explicit allowlist.
export interface TicketTypeView {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  // null only on a type saved before 2026-11 with no quantity (unlimited).
  quantity: number | null;
  soldCount: number;
  // quantity − sold − held (checkouts in progress); null when unlimited.
  remaining: number | null;
  hasSales: boolean;
  // The sales window: the instants, and the same in South African time
  // ("2027-03-02T18:00"), exactly as the organiser entered them.
  salesStart: Date | null;
  salesEnd: Date | null;
  salesStartLocal: string | null;
  salesEndLocal: string | null;
  // null = every day of the event.
  admittedDayIds: string[] | null;
  maxPerOrder: number;
  sortOrder: number;
  status: TicketTypeStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Kept for the invitation purchase path's imports.
export type CreateTicketDto = TicketTypeInput;
export type UpdateTicketDto = TicketTypeInput;
