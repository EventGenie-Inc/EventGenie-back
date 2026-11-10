import { emailSendRepository, type ClaimedEmailItem } from './email-send.repository.js';
import { setEmailSendWake } from './email-send.service.js';
import { sendEmailAttempt, waitForSendSlot } from '../../shared/messaging/email.engine.js';
import { inviteEmailRendering, type DispatchContext } from '../invite/invite-dispatch.service.js';
import { hasDeadlinePassed } from '../event/event-rsvp-deadline.util.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import prisma from '../../shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  THE EMAIL-SEND WORKER — invitations and reminders, one email at a time
//
//  Takes due emails a batch at a time (claimDue: SKIP LOCKED, a lease,
//  each take an attempt), builds each from the invite as it is NOW (the
//  guest's current days and the event's current design, with their QR
//  code), and sends it through Resend, paced by the engine's shared slots
//  (waitForSendSlot, 6 a second by default). Each email is built one after
//  another (a QR code is ~10 ms of synchronous work) and the calls overlap.
//
//  Never the same email twice: each Resend call carries the item's own
//  idempotency key (email-send-item/<id>), so an email taken again after a
//  worker died mid-send (its lease ran out) or after a restart is the same
//  email to Resend. Outcome writes are guarded by the lease.
//
//  Outcomes:
//    SENT     an invitation marks the invite delivered; a reminder writes
//             its InviteReminderLog row (sentBy: whoever pressed Remind).
//    retried  a 429, Resend's own trouble or no answer: back to QUEUED,
//             EMAIL_RETRY_BASE_MS then doubling, up to
//             EMAIL_SEND_MAX_ATTEMPTS calls in all.
//    FAILED   refused for good (an invalid address) or out of attempts. A
//             reminder gives back the cooldown it claimed and logs the
//             failure, as a failed in-request reminder did.
//    SKIPPED  no longer needed when its turn came: the guest or invite was
//             removed, a registration isn't approved, the event isn't open
//             (cancelled, completed, archived, made public), or for a
//             reminder the guest answered or replies closed. Nothing is
//             sent; a reminder gives its cooldown back.
//
//  Runs from server.ts only (startEmailSendWorker): every
//  EMAIL_SEND_POLL_MS, and at once when something is queued. Never
//  overlaps itself. Tests call runOnce.
// ─────────────────────────────────────────

export const EMAIL_SEND_BATCH_SIZE = 20;
export const EMAIL_SEND_LEASE_MS = 5 * 60 * 1000;
export const EMAIL_SEND_MAX_ATTEMPTS = 5;
export const EMAIL_RETRY_BASE_MS = 30 * 1000;
export const EMAIL_SEND_POLL_MS = 5 * 1000;

// After `attempts` calls: 30 s, 1, 2, 4 minutes.
export const emailRetryDelayMs = (attempts: number): number => EMAIL_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);

export const idempotencyKeyFor = (itemId: string): string => `email-send-item/${itemId}`;

export const SKIP_REASONS = {
  GUEST_REMOVED: 'Not sent: the guest was removed from the list before it went.',
  NOT_APPROVED: 'Not sent: their registration is not approved.',
  EVENT_CLOSED: 'Not sent: the event was no longer open when its turn came.',
  ANSWERED: 'Not sent: they replied before the reminder went.',
  REPLIES_CLOSED: 'Not sent: replies had closed before the reminder went.',
} as const;
export const NO_EMAIL_ADDRESS = 'This guest has no email address.';

type ItemInvite = Awaited<ReturnType<typeof emailSendRepository.findInvitesForItems>>[number];

// `eventId`: only that event's emails. Tests only: the test database holds
// every test file's queue. `now`: the clock, so a test can step past a
// retry's backoff or a lease.
export interface EmailSendRunOptions {
  now?: () => Date;
  eventId?: string;
}

export interface EmailSendRunResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

// Why this email shouldn't go now, or null if it should.
const skipReason = (item: ClaimedEmailItem, invite: ItemInvite | undefined): string | null => {
  if (!invite || invite.isArchived || invite.guest.isArchived) return SKIP_REASONS.GUEST_REMOVED;
  if (invite.guest.pendingApproval || invite.guest.registrationDeclinedAt) return SKIP_REASONS.NOT_APPROVED;
  const event = invite.event;
  if (event.isArchived || event.status !== 'PUBLISHED' || event.visibility !== 'PRIVATE') return SKIP_REASONS.EVENT_CLOSED;
  if (item.kind === 'REMINDER') {
    if (invite.status !== 'PENDING') return SKIP_REASONS.ANSWERED;
    if (hasDeadlinePassed(event.rsvpDeadline)) return SKIP_REASONS.REPLIES_CLOSED;
  }
  return null;
};

// A reminder that didn't go gives its cooldown back: only if it is still
// the one this send claimed, never a later one.
const releaseReminder = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], item: ClaimedEmailItem) =>
  item.kind === 'REMINDER' && item.remindedAt
    ? tx.invite.updateMany({
        where: { id: item.inviteId, lastRemindedAt: item.remindedAt },
        data: { lastRemindedAt: item.previousRemindedAt },
      })
    : Promise.resolve();

const logReminder = (
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  item: ClaimedEmailItem,
  invite: ItemInvite,
  sentBy: string,
  failureReason: string | null
) =>
  tx.inviteReminderLog.create({
    data: {
      tenantId: invite.event.tenantId,
      eventId: item.eventId,
      inviteId: item.inviteId,
      deliveryMethod: 'EMAIL',
      succeeded: failureReason === null,
      failureReason,
      sentBy,
    },
  });

export const emailSendWorker = {
  // Every due email, a batch at a time, until none is due.
  runOnce: async (options: EmailSendRunOptions = {}): Promise<EmailSendRunResult> => {
    const now = options.now ?? (() => new Date());
    const totals: EmailSendRunResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
    const contexts = new Map<string, Promise<DispatchContext>>();

    for (;;) {
      const claimedAt = now();
      const batch = await emailSendRepository.claimDue(claimedAt, new Date(claimedAt.getTime() + EMAIL_SEND_LEASE_MS), EMAIL_SEND_BATCH_SIZE, options.eventId);
      if (batch.length === 0) break;

      const [invites, sends] = await Promise.all([
        emailSendRepository.findInvitesForItems([...new Set(batch.map((i) => i.inviteId))]),
        emailSendRepository.findSends([...new Set(batch.map((i) => i.sendId))]),
      ]);
      const inviteById = new Map(invites.map((i) => [i.id, i]));
      const sentBy = new Map(sends.map((s) => [s.id, s.createdBy]));

      const finish = async (item: ClaimedEmailItem, status: 'FAILED' | 'SKIPPED', reason: string) => {
        const invite = inviteById.get(item.inviteId);
        await prisma.$transaction(async (tx) => {
          if (!(await emailSendRepository.markFinished(tx, item, status, reason, now()))) return;
          await releaseReminder(tx, item);
          if (status === 'FAILED' && item.kind === 'REMINDER' && invite) await logReminder(tx, item, invite, sentBy.get(item.sendId) ?? '', reason);
        });
        totals[status === 'FAILED' ? 'failed' : 'skipped'] += 1;
      };

      const sendOne = async (item: ClaimedEmailItem, invite: ItemInvite, email: Awaited<ReturnType<typeof inviteEmailRendering.buildEmailFor>>) => {
        const result = await sendEmailAttempt({ to: invite.guest.email!, ...email }, idempotencyKeyFor(item.id));
        if (result.ok) {
          await prisma.$transaction(async (tx) => {
            if (!(await emailSendRepository.markSent(tx, item, now()))) return;
            if (item.kind === 'INVITATION') {
              await tx.invite.update({ where: { id: item.inviteId }, data: { deliveredAt: now() } });
            } else {
              await logReminder(tx, item, invite, sentBy.get(item.sendId) ?? '', null);
            }
          });
          totals.sent += 1;
        } else if (result.retryable && item.attempts < EMAIL_SEND_MAX_ATTEMPTS) {
          await emailSendRepository.markRetry(item, new Date(now().getTime() + emailRetryDelayMs(item.attempts)), result.reason);
          totals.retried += 1;
        } else {
          await finish(item, 'FAILED', result.reason);
        }
      };

      const inFlight: Promise<void>[] = [];
      for (const item of batch) {
        try {
          const invite = inviteById.get(item.inviteId);
          const skip = skipReason(item, invite);
          if (skip) {
            await finish(item, 'SKIPPED', skip);
            continue;
          }
          if (!invite!.guest.email) {
            await finish(item, 'FAILED', NO_EMAIL_ADDRESS);
            continue;
          }
          let context = contexts.get(item.eventId);
          if (!context) {
            context = inviteEmailRendering.buildDispatchContext(invite!.event);
            contexts.set(item.eventId, context);
          }
          const email = await inviteEmailRendering.buildEmailFor(item.kind === 'INVITATION' ? 'INVITE' : 'REMINDER', await context, invite!);
          await waitForSendSlot();
          inFlight.push(
            sendOne(item, invite!, email).catch((err) => {
              // Left SENDING: taken again when its lease runs out, with the
              // same idempotency key.
              console.error(`[email-send] email ${item.id} could not be recorded`);
              reportError(err);
            })
          );
        } catch (err) {
          console.error(`[email-send] email ${item.id} could not be prepared`);
          reportError(err);
        }
      }
      await Promise.all(inFlight);
    }
    return totals;
  },
};

// Started by server.ts only, so tests start no timer (a test that starts
// it scopes it to its own event). Never overlaps itself, never keeps the
// process alive. Returns a stop function.
export const startEmailSendWorker = (options: Pick<EmailSendRunOptions, 'eventId'> = {}): (() => void) => {
  let running = false;
  let again = false;
  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await emailSendWorker.runOnce(options);
      } while (again);
    } catch (err) {
      console.error('[email-send] run failed');
      reportError(err);
    } finally {
      running = false;
    }
  };
  setEmailSendWake(() => void run());
  // Straight away on start: whatever a restart left queued or mid-send.
  const first = setTimeout(() => void run(), 0);
  const interval = setInterval(() => void run(), EMAIL_SEND_POLL_MS);
  first.unref();
  interval.unref();
  return () => {
    setEmailSendWake(null);
    clearTimeout(first);
    clearInterval(interval);
  };
};
