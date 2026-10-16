import { type PlatformRole } from '@prisma/client';
import { feedbackRepository } from './feedback.repository.js';
import { buildFeedbackRequestEmail } from './feedback-request-email.util.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { sendEmailBatch } from '../../shared/messaging/email.engine.js';
import { isUniqueViolationOn } from '../../shared/utils/prisma-error.util.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';

// ─────────────────────────────────────────
//  ASKING FOR FEEDBACK — the one scheduled job in this codebase
//
//  Until now nothing here ran on a timer, by choice: COMPLETED is derived at
//  read time, ticket holds are swept lazily, reminders are a button. An
//  email that should arrive the day after an event has no request to hang
//  off, so this is a periodic in-process sweep (startFeedbackRequestSweeps,
//  started by server.ts), built so that the timer itself guarantees
//  nothing:
//
//  - CLAIMED, AT MOST ONCE. Each event is claimed by inserting its
//    FeedbackRequestClaim row (unique per event) BEFORE anything is sent.
//    Two sweeps racing, on one server or several, both try; exactly one
//    insert succeeds, and only that sweep sends. A restart finds the claim
//    and skips the event. A send that fails after the claim is not retried
//    (the failure is reported); asking twice is worse than not asking.
//  - CATCHES UP. A sweep asks every event due within the last
//    FEEDBACK_REQUEST_WINDOW_DAYS, so a server asleep or down at the due time
//    sends on its next sweep. Older events are never asked: switching the
//    feature on, or a long outage, doesn't email organisers about events
//    from weeks ago.
//
//  Due: from 08:00 UTC on the day after the event's last day (a working
//  hour in South Africa, 10:00 SAST; events have no timezone, STEERING
//  "Known gaps"), and only once the event is COMPLETED. Never for a
//  cancelled or draft event, one with feedback already given, an archived
//  event or tenant, or while `feedback` is off.
//
//  Organisers: whoever created the event and the members assigned to it,
//  active and still able to open it (the assignment lock); when none is, the
//  tenant's active TENANT_ADMINs.
// ─────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// 08:00 UTC on the day after the last day = 32 hours after that day began.
export const FEEDBACK_REQUEST_DELAY_HOURS = 32;
export const FEEDBACK_REQUEST_WINDOW_DAYS = 7;
export const FEEDBACK_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// The first sweep waits for the server to finish starting.
export const FEEDBACK_SWEEP_FIRST_RUN_DELAY_MS = 60 * 1000;

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

interface Recipient {
  id: string;
  email: string;
}

type EventForRequest = NonNullable<Awaited<ReturnType<typeof feedbackRepository.findEventForFeedbackRequest>>>;
type RequestUser = EventForRequest['createdByUser'];

const ORGANISER_ROLES: PlatformRole[] = ['TENANT_ADMIN', 'EVENT_ADMIN'];

const resolveRecipients = async (event: EventForRequest): Promise<Recipient[]> => {
  const usable = (user: RequestUser): boolean =>
    user.isActive && !user.isArchived && user.tenantId === event.tenantId && ORGANISER_ROLES.includes(user.role);

  const assigned = event.assignments.map((a) => a.user).filter(usable);
  const recipients = new Map<string, Recipient>(assigned.map((u) => [u.id, { id: u.id, email: u.email }]));

  const creator = event.createdByUser;
  if (usable(creator) && !recipients.has(creator.id)) {
    // A locked EVENT_ADMIN who isn't assigned to this event can't open its
    // feedback page, so isn't asked.
    const canOpen = creator.role === 'TENANT_ADMIN' || (await feedbackRepository.countAssignmentsForUser(creator.id)) === 0;
    if (canOpen) recipients.set(creator.id, { id: creator.id, email: creator.email });
  }

  if (recipients.size > 0) return [...recipients.values()];
  const admins = await feedbackRepository.findActiveTenantAdmins(event.tenantId);
  return admins.map((u) => ({ id: u.id, email: u.email }));
};

export interface FeedbackRequestOutcome {
  eventId: string;
  recipientCount: number;
  failedCount: number;
}

export const feedbackRequestService = {
  // Claims and emails one event, or does nothing (null): not due after all,
  // or already claimed.
  requestFor: async (eventId: string): Promise<FeedbackRequestOutcome | null> => {
    const event = await feedbackRepository.findEventForFeedbackRequest(eventId);
    if (!event || resolveEffectiveStatus(event) !== 'COMPLETED') return null;

    const recipients = await resolveRecipients(event);

    try {
      await feedbackRepository.createRequestClaim(event.id, recipients.length);
    } catch (err) {
      if (isUniqueViolationOn(err, 'FeedbackRequestClaim', 'eventId')) return null;
      throw err;
    }

    if (recipients.length === 0) {
      console.warn(`[feedback request] event ${event.id} has no organiser to ask`);
      return { eventId: event.id, recipientCount: 0, failedCount: 0 };
    }

    const results = await sendEmailBatch(
      recipients.map((r) => buildFeedbackRequestEmail({ to: r.email, eventId: event.id, eventName: event.name }))
    );
    const failedCount = results.filter((r) => !r.ok).length;
    if (failedCount > 0) {
      // Counts only: an address never goes in a log line.
      console.error(`[feedback request] ${failedCount} of ${recipients.length} email(s) for event ${event.id} failed to send`);
    }
    return { eventId: event.id, recipientCount: recipients.length, failedCount };
  },

  // One pass: every due, unclaimed event, one at a time.
  sweep: async (now: Date = new Date()): Promise<FeedbackRequestOutcome[]> => {
    if (!isFeatureEnabled('feedback')) return [];

    const lastDayTo = isoDate(new Date(now.getTime() - FEEDBACK_REQUEST_DELAY_HOURS * HOUR_MS));
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const lastDayFrom = isoDate(new Date(today - FEEDBACK_REQUEST_WINDOW_DAYS * DAY_MS));

    const outcomes: FeedbackRequestOutcome[] = [];
    for (const eventId of await feedbackRepository.findFeedbackRequestCandidates(lastDayFrom, lastDayTo)) {
      try {
        const outcome = await feedbackRequestService.requestFor(eventId);
        if (outcome) outcomes.push(outcome);
      } catch (err) {
        // One event failing never stops the others.
        console.error(`[feedback request] event ${eventId} failed:`, err);
        reportError(err);
      }
    }
    return outcomes;
  },
};

// Starts the periodic sweep: once shortly after startup, then every
// FEEDBACK_SWEEP_INTERVAL_MS. A sweep still running when the next is due
// is not overlapped. The timers don't keep the process alive. Returns a
// stop function.
export const startFeedbackRequestSweeps = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await feedbackRequestService.sweep();
    } catch (err) {
      console.error('[feedback request] sweep failed:', err);
      reportError(err);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void run(), FEEDBACK_SWEEP_FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), FEEDBACK_SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
