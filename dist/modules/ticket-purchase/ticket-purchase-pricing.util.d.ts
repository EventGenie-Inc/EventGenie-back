export interface TicketChargeBreakdown {
    ticketPriceCents: number;
    commissionCents: number;
    totalChargeCents: number;
    platformChargeCents: number;
}
export declare const computeTicketChargeCents: (ticketPriceCents: number, quantity: number) => TicketChargeBreakdown;
//# sourceMappingURL=ticket-purchase-pricing.util.d.ts.map