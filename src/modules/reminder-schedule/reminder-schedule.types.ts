import { type ReminderScheduleStatus } from '@prisma/client';

// How the organiser picked the time. CUSTOM comes with `sendAt`, a South
// African date and time ("2026-11-20T09:00").
export const REMINDER_SCHEDULE_PRESETS = ['IN_1_DAY', 'IN_1_WEEK', 'IN_1_MONTH', 'CUSTOM'] as const;
export type ReminderSchedulePreset = (typeof REMINDER_SCHEDULE_PRESETS)[number];

// POST /api/events/:eventId/reminder-schedules
export interface CreateReminderScheduleInput {
  preset?: unknown;
  sendAt?: unknown;
}

// Why a schedule was SKIPPED when it was due (ReminderSchedule.skipReason).
export type ReminderScheduleSkipReason =
  | 'EVENT_ARCHIVED'
  | 'EVENT_CANCELLED'
  | 'EVENT_FINISHED'
  // A draft, or made public (public events have no invitations to remind).
  | 'EVENT_NOT_OPEN'
  | 'EVENT_STARTED'
  | 'RSVP_DEADLINE_PASSED'
  // Every guest has replied, or nobody was sent an invitation.
  | 'NO_ONE_WAITING'
  // Guests are still waiting, but none could be reminded now: all reminded
  // in the last 24 hours, or their invitations expired, or SMS only.
  | 'NONE_ELIGIBLE'
  // The event's daily email limit (EVENT_EMAILS_PER_DAY): refused whole,
  // as a manual reminder is.
  | 'EVENT_EMAIL_DAILY_LIMIT'
  // It couldn't be queued after REMINDER_SCHEDULE_MAX_ATTEMPTS tries.
  | 'ERROR';

// What the organiser sees for one schedule. Times: `sendAt` the instant
// (UTC, ISO), `sendAtLocal` the same in South African time.
export interface ReminderScheduleView {
  id: string;
  status: ReminderScheduleStatus;
  preset: string;
  sendAt: string;
  sendAtLocal: string;
  createdAt: string;
  createdBy: string;
  cancelledAt: string | null;
  // When it was queued (SENT) or skipped.
  processedAt: string | null;
  // SENT: the reminder send; GET .../invites/sends/:sendId for progress.
  sendId: string | null;
  // SENT: reminders queued. SENT or SKIPPED (when it got that far): guests
  // without a reply left out for the 24-hour cooldown, and for any other
  // reason (an expired invitation, SMS only, already queued).
  queued: number | null;
  skippedRecentlyReminded: number | null;
  skippedOther: number | null;
  // SENT: how the queued emails went, from the send itself.
  delivery: { queued: number; sent: number; failed: number; skipped: number } | null;
  skipReason: ReminderScheduleSkipReason | null;
  skipMessage: string | null;
}

// GET /api/events/:eventId/reminder-schedules
export interface ReminderScheduleList {
  schedules: ReminderScheduleView[];
  counts: Record<'scheduled' | 'sending' | 'sent' | 'skipped' | 'cancelled', number>;
  // At most this many SCHEDULED or SENDING at once.
  maxScheduled: number;
  // How many more can be scheduled now.
  remaining: number;
  cooldownHours: number;
  timeZone: string;
}
