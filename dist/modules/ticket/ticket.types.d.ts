export interface CreateTicketDto {
    name: string;
    description?: string;
    price: number;
    currency?: string;
    totalQuantity?: number;
}
export interface UpdateTicketDto {
    name?: string;
    description?: string;
    price?: number;
    currency?: string;
    totalQuantity?: number;
    isAvailable?: boolean;
}
//# sourceMappingURL=ticket.types.d.ts.map