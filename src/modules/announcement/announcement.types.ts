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
  // Guests it was meant to email (counted when the send was claimed).
  recipientCount: number;
  // Emails that went, and that failed, each counted from the delivery rows.
  // Not recipientCount minus failureCount: after a crash mid-send some
  // recipients have no row, and they were not reached.
  sentCount: number;
  failureCount: number;
  unreachableCount: number;
}

// How many more organiser announcements this event may send right now
// (ANNOUNCEMENTS_PER_EVENT_PER_DAY in any rolling 24 hours; the cancellation
// email never counts). The client shows these; it keeps no copy of the rule.
export interface AnnouncementDailyLimit {
  perDay: number;
  windowHours: number;
  sentInWindow: number;
  remaining: number;
  // When the next one can be sent; null while remaining > 0.
  nextAvailableAt: string | null;
}

// GET /api/events/:eventId/announcements.
export interface AnnouncementHistory {
  announcements: AnnouncementView[];
  dailyLimit: AnnouncementDailyLimit;
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
  // Only on the cancellation email, when it couldn't be sent at all: what
  // happened and what to do. Then `failures` and `unreachable` list every
  // guest who wasn't reached, as far as they could be loaded.
  error?: string;
}
