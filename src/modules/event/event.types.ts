import { type EventVisibility, type EventTicketing } from '@prisma/client';

export interface CreateEventDto {
  name: string;
  description?: string;
  location: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  coverImageUrl?: string;
  // Present only when coverImageUrl came from the signed-upload flow
  // (src/modules/upload/), not a pasted external link — see
  // event-cover-image.util.ts / schema.prisma for why it's independent.
  coverImagePublicId?: string;
  // Transient — reported by Cloudinary's own upload response, used only
  // to enforce the size limit at save time. Never persisted.
  coverImageBytes?: number;
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
  coverImageUrl?: string | null;
  coverImagePublicId?: string | null;
  coverImageBytes?: number;
  visibility?: EventVisibility;
  ticketing?: EventTicketing;
  invitationTemplate?: string;
  invitationConfig?: string;
  rsvpDeadline?: string | null;
  capacity?: number | null;
}
