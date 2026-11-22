import { calculateTicketOrderFees } from '../ticket-sales/ticket-fee-calculator.js';

// ─────────────────────────────────────────
//  The invitation purchase path's view of the ticket fee calculator.
//
//  Since ticket sales Round A (2026-11) every ticket price goes through ONE
//  calculator, ticket-sales/ticket-fee-calculator.ts (the gross-up, its
//  rounding, and Paystack's fee as configuration: payments.config.ts's
//  getTicketFeeConfig). This file only renames its result for the
//  invitation purchase path (ticket-purchase.service.ts), which Round B
//  replaces; it holds no arithmetic of its own.
// ─────────────────────────────────────────

export interface TicketChargeBreakdown {
  // What the organiser receives: price × quantity, exactly.
  ticketPriceCents: number;
  // e-velope's commission on it.
  commissionCents: number;
  // What the guest is charged: Paystack's `amount`.
  totalChargeCents: number;
  // What goes to e-velope's account through Paystack's `transaction_charge`
  // (total − ticket price), so the subaccount gets exactly the ticket price.
  platformChargeCents: number;
}

export const computeTicketChargeCents = (ticketPriceCents: number, quantity: number): TicketChargeBreakdown => {
  const fees = calculateTicketOrderFees({ unitPriceCents: ticketPriceCents, quantity });
  return {
    ticketPriceCents: fees.subtotalCents,
    commissionCents: fees.commissionCents,
    totalChargeCents: fees.totalCents,
    platformChargeCents: fees.transactionChargeCents,
  };
};
