import { type EventVisibility, type EventTicketing } from '@prisma/client';
export interface CreateEventDto {
    name: string;
    description?: string;
    coverImageUrl?: string;
    coverImagePublicId?: string;
    coverImageBytes?: number;
    visibility?: EventVisibility;
    ticketing?: EventTicketing;
    hostName?: string;
    rsvpDeadline?: string;
    capacity?: number;
    ticketsRefundable?: boolean;
}
export interface UpdateEventDto {
    name?: string;
    description?: string;
    coverImageUrl?: string | null;
    coverImagePublicId?: string | null;
    coverImageBytes?: number;
    visibility?: EventVisibility;
    ticketing?: EventTicketing;
    hostName?: string | null;
    rsvpDeadline?: string | null;
    capacity?: number | null;
    ticketsRefundable?: boolean;
}
//# sourceMappingURL=event.types.d.ts.map