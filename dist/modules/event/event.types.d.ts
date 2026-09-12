import { type EventVisibility, type EventTicketing } from '@prisma/client';
export interface CreateEventDto {
    name: string;
    description?: string;
    location: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    coverImageUrl?: string;
    coverImagePublicId?: string;
    coverImageBytes?: number;
    visibility?: EventVisibility;
    ticketing?: EventTicketing;
    invitationTemplate?: string;
    invitationConfig?: string;
    hostName?: string;
    rsvpDeadline?: string;
    capacity?: number;
    ticketsRefundable?: boolean;
}
export interface UpdateEventDto {
    name?: string;
    description?: string;
    location?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    coverImageUrl?: string | null;
    coverImagePublicId?: string | null;
    coverImageBytes?: number;
    visibility?: EventVisibility;
    ticketing?: EventTicketing;
    invitationTemplate?: string;
    invitationConfig?: string;
    hostName?: string | null;
    rsvpDeadline?: string | null;
    capacity?: number | null;
    ticketsRefundable?: boolean;
}
//# sourceMappingURL=event.types.d.ts.map