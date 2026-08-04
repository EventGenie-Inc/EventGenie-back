export interface SubmitRsvpDto {
    token: string;
    attending: boolean;
    attendingDayIds?: string[];
    rsvpResponses?: {
        rsvpFieldId: string;
        value: string;
    }[];
    ticketId?: string;
    ticketQuantity?: number;
    paymentRef?: string;
}
//# sourceMappingURL=rsvp.types.d.ts.map