// All monetary fields below are integer CENTS (money.util.ts's
// boundary) — converted to a Decimal string only at the repository's
// actual Prisma write, never before.

export interface CreatePendingTicketPurchaseDto {
  ticketId: string;
  inviteId: string;
  quantity: number;
  // Snapshot of the gross-up breakdown at THIS moment — see
  // schema.prisma's comment on TicketPurchase for why these are locked
  // in here rather than re-derived later from the (possibly since
  // edited) live Ticket.price.
  ticketPriceCents: number;
  commissionCents: number;
  totalPaidCents: number;
  currency: string;
  paymentRef: string;
  holdExpiresAt: Date;
}

// A retry re-uses the SAME TicketPurchase row (never creates a second
// one for the same invite+ticket) with a fresh Paystack reference, hold
// window, AND a freshly recomputed price breakdown (deliberately not
// the original one — a retry is a genuinely new payment attempt, and
// should reflect the ticket's current price/commission rate, same as a
// first-time purchase would) — see ticket-purchase.service.ts's
// retryPayment.
export interface RetryPaymentAttemptDto {
  paymentRef: string;
  holdExpiresAt: Date;
  ticketPriceCents: number;
  commissionCents: number;
  totalPaidCents: number;
}

// The row shape needed by the confirm/fail flow, locked via SELECT ...
// FOR UPDATE (ticket-purchase.repository.ts's findByIdForUpdate) so the
// status-transition-with-side-effects logic in
// ticket-purchase.service.ts can read the PRE-transition status safely.
export interface LockedTicketPurchase {
  id: string;
  ticketId: string;
  inviteId: string;
  eventId: string;
  tenantId: string;
  quantity: number;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  ticketPriceCents: number;
  commissionCents: number;
  totalPaidCents: number;
  currency: string;
  paymentRef: string | null;
}
