import { type EventStatus, type EventVisibility } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { deadlineEnd, hasDeadlinePassed } from '../event/event-rsvp-deadline.util.js';
import { eventFinishesAt } from '../event/event-status.util.js';
import { EVENT_EMAILS_PER_DAY } from '../invite/event-email-limit.util.js';
import { REMINDER_COOLDOWN_HOURS } from '../invite/invite-reminder.util.js';
import { formatSaLocal, wallClock } from './reminder-schedule-time.util.js';
import { type ReminderScheduleSkipReason } from './reminder-schedule.types.js';

// ─────────────────────────────────────────
//  SCHEDULED REMINDER RULES — pure, no database
//
//  When a reminder may be scheduled, and why a due one is skipped. The
//  same rules at both ends: a time refused when scheduling is the time the
//  worker would skip. Event values are literal UTC clocks; a reminder's
//  instant is compared as its South African wall clock (see
//  reminder-schedule-time.util.ts).
// ─────────────────────────────────────────

// At most this many SCHEDULED or SENDING per event.
export const MAX_SCHEDULED_REMINDERS_PER_EVENT = 5;

export const REMINDER_SCHEDULE_CODES = {
  INVALID: 'REMINDER_SCHEDULE_INVALID',
  IN_PAST: 'REMINDER_TIME_IN_PAST',
  AFTER_RSVP_DEADLINE: 'REMINDER_AFTER_RSVP_DEADLINE',
  AFTER_EVENT_START: 'REMINDER_AFTER_EVENT_START',
  LIMIT: 'REMINDER_SCHEDULE_LIMIT',
  NOT_CANCELLABLE: 'REMINDER_SCHEDULE_NOT_CANCELLABLE',
} as const;

export interface ScheduleRuleEvent {
  status: EventStatus;
  visibility: EventVisibility;
  isArchived: boolean;
  rsvpDeadline: Date | null;
  eventDays: { date: Date; startTime: Date | null; endTime: Date | null }[];
}

// When the event starts: its first live day's start time, else the start
// of that day.
export const eventStartsAt = (eventDays: ScheduleRuleEvent['eventDays']): Date | null => {
  if (eventDays.length === 0) return null;
  const first = eventDays.reduce((a, b) => (b.date < a.date ? b : a));
  return first.startTime ?? first.date;
};

// Refuses a time a reminder can't go at: not in the future, after replies
// close, or once the event has started. Each with its own code.
export const assertSendAtAllowed = (sendAt: Date, event: ScheduleRuleEvent, now: Date): void => {
  if (sendAt.getTime() <= now.getTime()) {
    throw new HttpError(422, 'That time has already passed. Pick a time in the future.', REMINDER_SCHEDULE_CODES.IN_PAST);
  }
  const wall = wallClock(sendAt);
  if (event.rsvpDeadline && hasDeadlinePassed(event.rsvpDeadline, wall)) {
    throw new HttpError(
      422,
      `Replies close at the end of ${formatGuestDate(deadlineEnd(event.rsvpDeadline))}, so a reminder after that would ask guests ` +
        `to reply when they no longer can. Pick an earlier time, or extend the RSVP deadline first.`,
      REMINDER_SCHEDULE_CODES.AFTER_RSVP_DEADLINE
    );
  }
  const startsAt = eventStartsAt(event.eventDays);
  if (startsAt && wall >= startsAt) {
    throw new HttpError(
      422,
      `The event starts on ${formatGuestDate(startsAt)}, so a reminder at ${formatSaLocal(sendAt).replace('T', ' ')} would arrive ` +
        `after it has begun. Pick an earlier time.`,
      REMINDER_SCHEDULE_CODES.AFTER_EVENT_START
    );
  }
};

// Why a due reminder can't go because of the event itself, or null.
// `event.status` is the stored one (COMPLETED is derived here).
export const eventSkipReason = (event: ScheduleRuleEvent, now: Date): ReminderScheduleSkipReason | null => {
  if (event.isArchived) return 'EVENT_ARCHIVED';
  if (event.status === 'CANCELLED') return 'EVENT_CANCELLED';
  const wall = wallClock(now);
  const finishesAt = eventFinishesAt(event);
  if (finishesAt && finishesAt < wall) return 'EVENT_FINISHED';
  if (event.status !== 'PUBLISHED' || event.visibility !== 'PRIVATE') return 'EVENT_NOT_OPEN';
  const startsAt = eventStartsAt(event.eventDays);
  if (startsAt && startsAt <= wall) return 'EVENT_STARTED';
  if (hasDeadlinePassed(event.rsvpDeadline, wall)) return 'RSVP_DEADLINE_PASSED';
  return null;
};

export const SCHEDULE_SKIP_MESSAGES: Record<ReminderScheduleSkipReason, string> = {
  EVENT_ARCHIVED: 'Not sent: the event was archived.',
  EVENT_CANCELLED: 'Not sent: the event was cancelled.',
  EVENT_FINISHED: 'Not sent: the event had already finished.',
  EVENT_NOT_OPEN: 'Not sent: the event was no longer open for invitations.',
  EVENT_STARTED: 'Not sent: the event had already started.',
  RSVP_DEADLINE_PASSED: 'Not sent: replies had closed (the RSVP deadline had passed).',
  NO_ONE_WAITING: 'Not sent: nobody was left without a reply. Every guest who was sent an invitation had replied.',
  NONE_ELIGIBLE:
    `Not sent: the guests who haven't replied couldn't be reminded now. They were reminded in the last ` +
    `${REMINDER_COOLDOWN_HOURS} hours, their invitation has expired, or they can only be reached by text message.`,
  // Its own words, not the manual refusal's: "Choose fewer guests" is
  // nothing a scheduled reminder's organiser can act on.
  EVENT_EMAIL_DAILY_LIMIT:
    `Not sent: today's email limit for this event was reached (${EVENT_EMAILS_PER_DAY.toLocaleString('en-US')} ` +
    'invitation and reminder emails in 24 hours), so this reminder was skipped and nobody was emailed. ' +
    'You can schedule another one for tomorrow.',
  ERROR: 'Not sent: something went wrong while queueing it. Send a reminder from the guest list instead.',
};
