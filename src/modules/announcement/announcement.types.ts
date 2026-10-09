import { type AnnouncementAudience, type AnnouncementKind } from '@prisma/client';
import { type UnreachableGuest } from './announcement-audience.util.js';

// Request bodies arrive as whatever the client sent; the service checks
// every field's type (400) before its value (422).
export interface AnnouncementAudienceDto {
  audience?: unknown;
  eventDayId?: unknown;
}

export interface SendAnnouncementDto extends AnnouncementAudienceDto {
  subject?: unknown;
  body?: unknown;
}

export interface CancelEventDto {
  note?: unknown;
}

export interface AnnouncementPreview {
  audience: AnnouncementAudience;
  eventDayId: string | null;
  // Guests who will be emailed.
  recipientCount: number;
  // Guests in the audience with no email address.
  unreachableCount: number;
  unreachable: UnreachableGuest[];
}

export interface AnnouncementFailure {
  guestId: string;
  name: string;
  email: string;
  reason: string;
}

// One entry in the history (GET /api/events/:eventId/announcements).
export interface AnnouncementView {
  id: string;
  kind: AnnouncementKind;
  subject: string;
  body: string | null;
  audience: AnnouncementAudience;
  eventDayId: string | null;
  eventDayLabel: string | null;
  sentBy: string;
  sentAt: string;
  recipientCount: number;
  failureCount: number;
  unreachableCount: number;
}

// What a send (and the cancellation email) reports back to the organiser.
export interface AnnouncementDeliveryReport {
  // Null only when nobody was in the audience, so nothing was recorded.
  announcement: AnnouncementView | null;
  sent: number;
  failed: number;
  failures: AnnouncementFailure[];
  unreachableCount: number;
  unreachable: UnreachableGuest[];
  // Only on the cancellation email, when it couldn't be sent at all.
  error?: string;
}
