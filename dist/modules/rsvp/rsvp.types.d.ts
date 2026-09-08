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
    plusOneNames?: string[];
    firstName?: string;
    surname?: string;
    email?: string;
    phoneNumber?: string;
}
//# sourceMappingURL=rsvp.types.d.ts.map