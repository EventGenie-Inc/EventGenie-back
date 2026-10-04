export interface CreateTicketDto {
  name: string;
  description?: string;
  price: number;
  currency?: string;
  // Whole number, 0 or more; null or blank = unlimited (422 otherwise).
  totalQuantity?: number | null;
}

export interface UpdateTicketDto {
  name?: string;
  description?: string;
  price?: number;
  currency?: string;
  totalQuantity?: number | null;
  isAvailable?: boolean;
}
