import { reminderScheduleRepository, type ClaimedSchedule, type ScheduleOutcomeCounts } from './reminder-schedule.repository.js';
import { eventSkipReason, SCHEDULE_SKIP_MESSAGES } from './reminder-schedule-rules.util.js';
import { type ReminderScheduleSkipReason } from './reminder-schedule.types.js';
import { enqueueLocked, wakeEmailSendWorker } from '../email-send/email-send.service.js';
import { eventEmailClaimRepository } from '../invite/event-email-claim.repository.js';
import { EVENT_EMAIL_DAILY_LIMIT } from '../invite/event-email-limit.util.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { classifyGuestForReminder, REMINDER_COOLDOWN_MS, type ReminderInvite } from '../invite/invite-reminder.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';

// ─────────────────────────────────────────
//  THE SCHEDULED-REMINDER WORKER — hands a due schedule to the email queue
//
//  Takes due schedules (claimDue: a materialized CTE, SKIP LOCKED, a
//  lease, each take an attempt) and for each, at the moment it is taken:
//    - skips it, with the reason, if the event can't be reminded now
//      (archived, cancelled, finished, not open, started, replies closed);
//    - picks the guests a manual "Remind everyone" would (delivered, not
//      replied, live, approved, not plus-ones; classifyGuestForReminder),
//      email only: the email queue is what sends it;
//    - in ONE transaction under the event's email lock, claims those
//      guests' 24-hour cooldown, queues a REMINDER send (enqueueLocked: the
//      duplicate check and the daily limit, all or nothing) and marks the
//      schedule SENT with its counts. A crash anywhere inside leaves
//      nothing behind, and the schedule is taken again when its lease runs
//      out; a second worker can't take it while the lease holds, and its
//      outcome write is guarded by the lease, so it is queued exactly once.
//  The email-send worker then sends it: pacing, retries, the QR code, a
//  guest who replies before their email goes is skipped.
//
//  Over the daily email limit: refused whole, as a manual reminder is, and
//  the schedule is SKIPPED with the refusal's own words.
//
//  Runs from server.ts only (startReminderScheduleWorker). Tests call
//  runOnce. With scheduledReminders off it does nothing.
// ─────────────────────────────────────────

export const REMINDER_SCHEDULE_BATCH_SIZE = 10;
export const REMINDER_SCHEDULE_LEASE_MS = 5 * 60 * 1000;
export const REMINDER_SCHEDULE_MAX_ATTEMPTS = 5;
export const REMINDER_SCHEDULE_POLL_MS = 30 * 1000;

export interface ReminderScheduleRunOptions {
  now?: () => Date;
  // Only that event's schedules. Tests only: the test database holds every
  // test file's schedules.
  eventId?: string;
}

export interface ReminderScheduleRunResult {
  sent: number;
  skipped: number;
  // Left for its lease to run out (an unexpected error), or lost to
  // another worker.
  notFinished: number;
}

// The lease ran out and another worker has the schedule: roll back.
class LeaseLost extends Error {}

type Outcome = 'sent' | 'skipped' | 'notFinished';

const processSchedule = async (item: ClaimedSchedule, at: Date): Promise<Outcome> => {
  const counts: ScheduleOutcomeCounts = {};
  const skip = async (reason: ReminderScheduleSkipReason, message = SCHEDULE_SKIP_MESSAGES[reason]): Promise<Outcome> =>
    (await reminderScheduleRepository.markSkipped(item, reason, message, counts, at))
      ? 'skipped'
      : 'notFinished';

  if (item.attempts > REMINDER_SCHEDULE_MAX_ATTEMPTS) return skip('ERROR');

  try {
    const event = await reminderScheduleRepository.findEventForWorker(item.eventId);
    const eventReason = event ? eventSkipReason(event, at) : 'EVENT_ARCHIVED';
    if (eventReason) return await skip(eventReason);

    // The guests, per guest (never per invite), as a manual reminder sees them.
    const invites = (await inviteRepository.findReminderCandidates(item.eventId)) as (ReminderInvite & { deliveryMethod: string })[];
    const byGuest = new Map<string, ReminderInvite[]>();
    for (const invite of invites) byGuest.set(invite.guestId, [...(byGuest.get(invite.guestId) ?? []), invite]);

    const toRemind: ReminderInvite[] = [];
    let recentlyReminded = 0;
    let other = 0;
    for (const group of byGuest.values()) {
      const verdict = classifyGuestForReminder(group, at);
      if ('remind' in verdict) toRemind.push(verdict.remind);
      else if (verdict.skip === 'RECENTLY_REMINDED') recentlyReminded += 1;
      else if (verdict.skip === 'INVITE_EXPIRED') other += 1;
      // ALREADY_RESPONDED, NOT_INVITED_YET: not waiting on a reminder.
    }
    if (toRemind.length + recentlyReminded + other === 0) return await skip('NO_ONE_WAITING');

    // Email only: this is the email queue's send. An SMS-only guest is left out.
    const emailTargets = toRemind.filter((i) => i.deliveryMethod === 'EMAIL');
    other += toRemind.length - emailTargets.length;
    counts.skippedRecentlyReminded = recentlyReminded;
    counts.skippedOther = other;

    const result = await eventEmailClaimRepository.withEventEmailLock(item.eventId, async (tx): Promise<Outcome> => {
      if (!(await reminderScheduleRepository.holdsLease(tx, item))) throw new LeaseLost();

      // The cooldown, re-checked at the moment of the write (still pending,
      // not reminded in the last 24 hours), as a manual reminder claims it.
      const claimedIds = await inviteRepository.claimReminders(
        emailTargets.map((i) => i.id),
        new Date(at.getTime() - REMINDER_COOLDOWN_MS),
        at,
        tx
      );
      const lost = emailTargets.filter((i) => !claimedIds.has(i.id));
      if (lost.length) {
        // Lost since they were read: reminded by someone else (cooldown),
        // or they replied (no longer waiting).
        const still = await tx.invite.count({ where: { id: { in: lost.map((i) => i.id) }, status: 'PENDING' } });
        counts.skippedRecentlyReminded = (counts.skippedRecentlyReminded ?? 0) + still;
      }
      const claimed = emailTargets.filter((i) => claimedIds.has(i.id));

      const queued = await enqueueLocked(tx, {
        eventId: item.eventId,
        kind: 'REMINDER',
        createdBy: item.createdBy,
        items: claimed.map((i) => ({ inviteId: i.id, remindedAt: at, previousRemindedAt: i.lastRemindedAt })),
      });
      // Already queued, or sent minutes ago: not queued again, and the
      // cooldown just claimed goes back.
      const notQueued = claimed.filter((i) => !queued.queuedInviteIds.has(i.id));
      await inviteRepository.releaseReminderClaims(notQueued.map((i) => ({ id: i.id, previous: i.lastRemindedAt })), at, tx);
      counts.skippedOther = (counts.skippedOther ?? 0) + notQueued.length;
      counts.queuedCount = queued.queuedInviteIds.size;

      if (!queued.sendId) {
        const nobody = (counts.skippedRecentlyReminded ?? 0) + (counts.skippedOther ?? 0) === 0;
        const reason: ReminderScheduleSkipReason = nobody ? 'NO_ONE_WAITING' : 'NONE_ELIGIBLE';
        if (!(await reminderScheduleRepository.markSkipped(item, reason, SCHEDULE_SKIP_MESSAGES[reason], counts, at, tx))) throw new LeaseLost();
        return 'skipped';
      }
      if (!(await reminderScheduleRepository.markSent(tx, item, queued.sendId, counts, at))) throw new LeaseLost();
      return 'sent';
    });

    if (result === 'sent') wakeEmailSendWorker();
    return result;
  } catch (err) {
    if (err instanceof LeaseLost) return 'notFinished';
    if (err instanceof HttpError && err.code === EVENT_EMAIL_DAILY_LIMIT) {
      // Nothing was queued and no cooldown started (the transaction rolled
      // back): as a manual reminder over the limit. The organiser sees why,
      // in words for a reminder that was scheduled, not the button's.
      delete counts.queuedCount;
      return skip('EVENT_EMAIL_DAILY_LIMIT');
    }
    // Left SENDING: taken again when its lease runs out.
    console.error(`[reminder-schedule] schedule ${item.id} could not be queued`);
    reportError(err);
    return 'notFinished';
  }
};

export const reminderScheduleWorker = {
  // Every due schedule, a batch at a time, until none is due.
  runOnce: async (options: ReminderScheduleRunOptions = {}): Promise<ReminderScheduleRunResult> => {
    const totals: ReminderScheduleRunResult = { sent: 0, skipped: 0, notFinished: 0 };
    if (!isFeatureEnabled('scheduledReminders')) return totals;
    const now = options.now ?? (() => new Date());

    for (;;) {
      const claimedAt = now();
      const batch = await reminderScheduleRepository.claimDue(
        claimedAt,
        new Date(claimedAt.getTime() + REMINDER_SCHEDULE_LEASE_MS),
        REMINDER_SCHEDULE_BATCH_SIZE,
        options.eventId
      );
      if (batch.length === 0) break;
      for (const item of batch) totals[await processSchedule(item, now())] += 1;
    }
    return totals;
  },
};

// Started by server.ts only, so tests start no timer. Never overlaps
// itself, never keeps the process alive. Returns a stop function.
export const startReminderScheduleWorker = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await reminderScheduleWorker.runOnce();
    } catch (err) {
      console.error('[reminder-schedule] run failed');
      reportError(err);
    } finally {
      running = false;
    }
  };
  // Straight away on start: whatever came due while the server was down.
  const first = setTimeout(() => void run(), 0);
  const interval = setInterval(() => void run(), REMINDER_SCHEDULE_POLL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
