import { type EventVisibility, type EventTicketing } from '@prisma/client';

export interface CreateEventDto {
  name: string;
  description?: string;
  location: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  coverImageUrl?: string;
  visibility?: EventVisibility;
  ticketing?: EventTicketing;
  invitationTemplate?: string;
  invitationConfig?: string;
  rsvpDeadline?: string;
  capacity?: number;
}

export interface UpdateEventDto {
  name?: string;
  description?: string;
  location?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  coverImageUrl?: string;
  visibility?: EventVisibility;
  ticketing?: EventTicketing;
  invitationTemplate?: string;
  invitationConfig?: string;
  rsvpDeadline?: string | null;
  capacity?: number | null;
}
