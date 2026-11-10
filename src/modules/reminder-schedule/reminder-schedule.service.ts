import { type PlatformRole, type ReminderSchedule } from '@prisma/client';
import { reminderScheduleRepository } from './reminder-schedule.repository.js';
import {
  assertSendAtAllowed,
  MAX_SCHEDULED_REMINDERS_PER_EVENT,
  REMINDER_SCHEDULE_CODES,
} from './reminder-schedule-rules.util.js';
import { formatSaLocal, parseSaLocal, presetSendAt, SA_TIME_ZONE } from './reminder-schedule-time.util.js';
import {
  REMINDER_SCHEDULE_PRESETS,
  type CreateReminderScheduleInput,
  type ReminderScheduleList,
  type ReminderSchedulePreset,
  type ReminderScheduleSkipReason,
  type ReminderScheduleView,
} from './reminder-schedule.types.js';
import { eventService } from '../event/event.service.js';
import { assertEventIsPublished } from '../event/event-status.util.js';
import { eventEmailClaimRepository } from '../invite/event-email-claim.repository.js';
import { assertRsvpDeadlineNotPassed, REMINDER_COOLDOWN_HOURS } from '../invite/invite-reminder.util.js';
import { HttpError } from '../../shared/errors/http-error.js';

// ─────────────────────────────────────────
//  SCHEDULED REMINDERS — the organiser's side
//
//  Schedule ("in 1 day", "in 1 week", "in 1 month", or a South African date
//  and time), list, cancel. Organisers of the event only, tenant-scoped
//  like every invite route (eventService.getScoped: another tenant's event,
//  an unassigned one and a missing one are the same 404). Sending is the
//  worker's (reminder-schedule.worker.ts).
// ─────────────────────────────────────────

type DeliveryRow = Awaited<ReturnType<typeof reminderScheduleRepository.deliveryCounts>>[number];

const toView = (row: ReminderSchedule, delivery: DeliveryRow[] = []): ReminderScheduleView => {
  const mine = row.emailSendId ? delivery.filter((d) => d.sendId === row.emailSendId) : [];
  const n = (...statuses: string[]) => mine.filter((d) => statuses.includes(d.status)).reduce((sum, d) => sum + d._count._all, 0);
  return {
    id: row.id,
    status: row.status,
    preset: row.preset,
    sendAt: row.sendAt.toISOString(),
    sendAtLocal: formatSaLocal(row.sendAt),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    processedAt: row.processedAt?.toISOString() ?? null,
    sendId: row.emailSendId,
    queued: row.queuedCount,
    skippedRecentlyReminded: row.skippedRecentlyReminded,
    skippedOther: row.skippedOther,
    delivery: row.emailSendId ? { queued: n('QUEUED', 'SENDING'), sent: n('SENT'), failed: n('FAILED'), skipped: n('SKIPPED') } : null,
    skipReason: (row.skipReason as ReminderScheduleSkipReason | null) ?? null,
    skipMessage: row.skipMessage,
  };
};

const NOT_CANCELLABLE_MESSAGES: Partial<Record<ReminderSchedule['status'], string>> = {
  SENDING: 'This reminder is being sent right now, so it can no longer be cancelled.',
  SENT: 'This reminder has already been sent.',
  SKIPPED: "This reminder didn't go out, so there is nothing to cancel.",
};

const isPreset = (value: unknown): value is ReminderSchedulePreset =>
  typeof value === 'string' && (REMINDER_SCHEDULE_PRESETS as readonly string[]).includes(value);

// The time asked for, or a 400 saying what is wrong with the request.
const resolveSendAt = (input: CreateReminderScheduleInput, now: Date): { preset: ReminderSchedulePreset; sendAt: Date } => {
  if (!isPreset(input.preset)) {
    throw new HttpError(400, `preset must be one of ${REMINDER_SCHEDULE_PRESETS.join(', ')}.`, REMINDER_SCHEDULE_CODES.INVALID);
  }
  if (input.preset !== 'CUSTOM') {
    if (input.sendAt !== undefined && input.sendAt !== null) {
      throw new HttpError(400, 'sendAt is only for a CUSTOM time. Leave it out for a preset.', REMINDER_SCHEDULE_CODES.INVALID);
    }
    return { preset: input.preset, sendAt: presetSendAt(input.preset, now) };
  }
  const sendAt = typeof input.sendAt === 'string' ? parseSaLocal(input.sendAt) : null;
  if (!sendAt) {
    throw new HttpError(
      400,
      'Choose a valid date and time for the reminder (South African time, as 2026-11-20T09:00).',
      REMINDER_SCHEDULE_CODES.INVALID
    );
  }
  return { preset: 'CUSTOM', sendAt };
};

export const reminderScheduleService = {
  list: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<ReminderScheduleList> => {
    // A read: an archived event's history still lists.
    await eventService.getScoped(eventId, requestingRole, tenantId, true);
    const rows = await reminderScheduleRepository.listForEvent(eventId);
    const delivery = await reminderScheduleRepository.deliveryCounts(rows.flatMap((r) => (r.emailSendId ? [r.emailSendId] : [])));
    const count = (status: ReminderSchedule['status']) => rows.filter((r) => r.status === status).length;
    const active = count('SCHEDULED') + count('SENDING');
    return {
      schedules: rows.map((r) => toView(r, delivery)),
      counts: {
        scheduled: count('SCHEDULED'),
        sending: count('SENDING'),
        sent: count('SENT'),
        skipped: count('SKIPPED'),
        cancelled: count('CANCELLED'),
      },
      maxScheduled: MAX_SCHEDULED_REMINDERS_PER_EVENT,
      remaining: Math.max(0, MAX_SCHEDULED_REMINDERS_PER_EVENT - active),
      cooldownHours: REMINDER_COOLDOWN_HOURS,
      timeZone: SA_TIME_ZONE,
    };
  },

  create: async (
    eventId: string,
    input: CreateReminderScheduleInput,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<ReminderScheduleView> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    // The gates a manual reminder has, in its order.
    assertEventIsPublished(event.status, 'scheduling reminders');
    if (event.visibility !== 'PRIVATE') {
      throw new HttpError(400, "Public events don't use invitations, so there is no one to remind. Share the event's public link instead.");
    }
    assertRsvpDeadlineNotPassed(event.rsvpDeadline);

    const now = new Date();
    const { preset, sendAt } = resolveSendAt(input ?? {}, now);
    assertSendAtAllowed(sendAt, event, now);

    // Counted and written under the event's lock, so two at once can't
    // both take the last place.
    const row = await eventEmailClaimRepository.withEventEmailLock(eventId, async (tx) => {
      if ((await reminderScheduleRepository.countActive(tx, eventId)) >= MAX_SCHEDULED_REMINDERS_PER_EVENT) {
        throw new HttpError(
          409,
          `This event already has ${MAX_SCHEDULED_REMINDERS_PER_EVENT} reminders scheduled, the most it can have at once. ` +
            'Cancel one, or wait for one to go out, before scheduling another.',
          REMINDER_SCHEDULE_CODES.LIMIT
        );
      }
      return reminderScheduleRepository.create(tx, { eventId, sendAt, preset, createdBy: userId });
    });
    return toView(row);
  },

  cancel: async (
    eventId: string,
    scheduleId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<ReminderScheduleView> => {
    await eventService.getScoped(eventId, requestingRole, tenantId);
    const existing = await reminderScheduleRepository.findForEvent(scheduleId, eventId);
    if (!existing) throw new HttpError(404, 'Scheduled reminder not found');
    // Cancelling twice is not an error: it is cancelled.
    if (existing.status === 'CANCELLED') return toView(existing);

    if (!(await reminderScheduleRepository.cancel(scheduleId, eventId, userId, new Date()))) {
      // Taken by the worker (or finished) between the read and the write.
      const now = (await reminderScheduleRepository.findForEvent(scheduleId, eventId))!;
      if (now.status === 'CANCELLED') return toView(now);
      throw new HttpError(
        409,
        NOT_CANCELLABLE_MESSAGES[now.status] ?? 'This reminder can no longer be cancelled.',
        REMINDER_SCHEDULE_CODES.NOT_CANCELLABLE
      );
    }
    return toView((await reminderScheduleRepository.findForEvent(scheduleId, eventId))!);
  },
};
