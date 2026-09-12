export interface CreatePendingTicketPurchaseDto {
    ticketId: string;
    inviteId: string;
    quantity: number;
    ticketPriceCents: number;
    commissionCents: number;
    totalPaidCents: number;
    currency: string;
    paymentRef: string;
    holdExpiresAt: Date;
}
export interface RetryPaymentAttemptDto {
    paymentRef: string;
    holdExpiresAt: Date;
    ticketPriceCents: number;
    commissionCents: number;
    totalPaidCents: number;
}
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
//# sourceMappingURL=ticket-purchase.types.d.ts.map