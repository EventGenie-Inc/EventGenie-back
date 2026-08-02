export interface CreateTicketPurchaseDto {
  ticketId: string;
  inviteId: string;
  quantity?: number;
  totalPaid: number;
  currency?: string;
  paymentRef?: string;
}
