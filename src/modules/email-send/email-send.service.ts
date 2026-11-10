import { type EventEmailKind, type PlatformRole, type Prisma } from '@prisma/client';
import { emailSendRepository, type NewEmailItem } from './email-send.repository.js';
import { type EmailSendProgress, type EnqueueResult, type NotQueuedReason } from './email-send.types.js';
import { eventEmailClaimRepository } from '../invite/event-email-claim.repository.js';
import { claimEventEmailsLocked } from '../invite/event-email-limit.util.js';
import { eventService } from '../event/event.service.js';
import { HttpError } from '../../shared/errors/http-error.js';

// ─────────────────────────────────────────
//  THE EMAIL-SEND QUEUE — invitations and reminders
//
//  enqueue writes one EmailSendItem per email under a new EmailSend and
//  returns; the worker (email-send.worker.ts) sends them. Nothing is sent
//  here, so pressing Send answers at once however many guests there are.
//
//  Never the same email twice. Under the event's email lock (the one the
//  daily limit takes), in one transaction:
//    - an invite whose email of this kind is already QUEUED or SENDING is
//      left out (ALREADY_QUEUED), with the send that has it;
//    - one SENT within DUPLICATE_SEND_WINDOW_MS is left out
//      (RECENTLY_SENT): a second press of Send, or a browser retrying the
//      request, after the first emails already went;
//    - the rest are claimed against the daily limit (all or nothing, as
//      before: refused, nothing is queued) and queued.
//  The partial unique index on (inviteId, kind) while waiting backs the
//  first rule up in the database itself. After the window a deliberate
//  re-send goes as it always did.
// ─────────────────────────────────────────

export const DUPLICATE_SEND_WINDOW_MS = 10 * 60 * 1000;
export const DUPLICATE_SEND_WINDOW_MINUTES = DUPLICATE_SEND_WINDOW_MS / 60_000;

export const NOT_QUEUED_MESSAGES: Record<NotQueuedReason, string> = {
  ALREADY_QUEUED: "Already on its way: this email is in a send that hasn't finished, so it wasn't added again.",
  RECENTLY_SENT:
    `Sent in the last ${DUPLICATE_SEND_WINDOW_MINUTES} minutes, so it wasn't sent again. ` +
    'Try again later if they still haven’t received it.',
};

const guestName = (guest: { firstName: string | null; surname: string | null }): string =>
  [guest.firstName, guest.surname].filter(Boolean).join(' ').trim() || 'Guest';

// Wakes the worker after something is queued; set by startEmailSendWorker
// (server.ts) only, so in tests nothing is sent until a test runs the
// worker itself.
let wake: (() => void) | null = null;
export const setEmailSendWake = (fn: (() => void) | null): void => {
  wake = fn;
};

// Wakes the worker now: after enqueue (below), or after a transaction that
// called enqueueLocked has committed (a scheduled reminder).
export const wakeEmailSendWorker = (): void => {
  wake?.();
};

export interface EnqueueInput {
  eventId: string;
  kind: EventEmailKind;
  createdBy: string;
  items: NewEmailItem[];
}

// The queueing itself, inside a transaction that already holds the event's
// email lock (withEventEmailLock): the duplicate check, the daily-limit
// claim (throws the 429, and the caller's transaction rolls back) and the
// rows. The scheduled-reminder worker calls it with its own work in the
// same transaction (reminder-schedule.worker.ts); the caller wakes the
// worker once it has committed.
export const enqueueLocked = async (tx: Prisma.TransactionClient, input: EnqueueInput): Promise<EnqueueResult> => {
  const result: EnqueueResult = { sendId: null, queuedInviteIds: new Set(), notQueued: new Map() };
  if (input.items.length === 0) return result;

  const blocking = await emailSendRepository.findBlocking(
    tx,
    input.items.map((i) => i.inviteId),
    input.kind,
    new Date(Date.now() - DUPLICATE_SEND_WINDOW_MS)
  );
  for (const row of blocking) {
    // Waiting beats recently sent: that's the send to watch.
    const reason: NotQueuedReason = row.status === 'SENT' ? 'RECENTLY_SENT' : 'ALREADY_QUEUED';
    const existing = result.notQueued.get(row.inviteId);
    if (!existing || reason === 'ALREADY_QUEUED') result.notQueued.set(row.inviteId, { reason, sendId: row.sendId });
  }
  const toQueue = input.items.filter((i) => !result.notQueued.has(i.inviteId));
  if (toQueue.length === 0) return result;

  await claimEventEmailsLocked(tx, input.eventId, input.kind, toQueue.length, input.createdBy);
  const send = await emailSendRepository.createSend(tx, { eventId: input.eventId, kind: input.kind, createdBy: input.createdBy });
  const written = await emailSendRepository.createItems(tx, { id: send.id, eventId: input.eventId, kind: input.kind }, toQueue);
  result.sendId = send.id;
  for (const row of written) result.queuedInviteIds.add(row.inviteId);
  // Under the lock nothing else can have queued these since the check;
  // if the index refused one anyway, it is reported as already queued.
  for (const item of toQueue) {
    if (!result.queuedInviteIds.has(item.inviteId)) result.notQueued.set(item.inviteId, { reason: 'ALREADY_QUEUED', sendId: send.id });
  }
  return result;
};

export const emailSendService = {
  enqueue: async (input: EnqueueInput): Promise<EnqueueResult> => {
    if (input.items.length === 0) return { sendId: null, queuedInviteIds: new Set(), notQueued: new Map() };
    const result = await eventEmailClaimRepository.withEventEmailLock(input.eventId, (tx) => enqueueLocked(tx, input));
    if (result.sendId) wakeEmailSendWorker();
    return result;
  },

  getProgress: async (
    eventId: string,
    sendId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<EmailSendProgress> => {
    await eventService.getById(eventId, requestingRole, tenantId); // 404 outside the caller's scope
    const send = await emailSendRepository.findSendForEvent(sendId, eventId);
    if (!send) throw new HttpError(404, 'Send not found');

    const [counts, unsent, latest] = await Promise.all([
      emailSendRepository.countByStatus(sendId),
      emailSendRepository.findUnsent(sendId),
      emailSendRepository.latestFinishedAt(sendId),
    ]);
    const count = (...statuses: string[]) => counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c._count._all, 0);
    const queued = count('QUEUED', 'SENDING');
    const toGuest = (row: (typeof unsent)[number]) => ({
      guestId: row.invite.guestId,
      name: guestName(row.invite.guest),
      contact: row.invite.guest.email ?? '',
      reason: row.lastError ?? '',
    });
    const last = [latest._max.sentAt, latest._max.finishedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      id: send.id,
      kind: send.kind,
      createdAt: send.createdAt.toISOString(),
      total: count('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'),
      queued,
      sent: count('SENT'),
      failed: count('FAILED'),
      skipped: count('SKIPPED'),
      done: queued === 0,
      finishedAt: queued === 0 && last ? last.toISOString() : null,
      failures: unsent.filter((r) => r.status === 'FAILED').map(toGuest),
      skippedGuests: unsent.filter((r) => r.status === 'SKIPPED').map(toGuest),
    };
  },
};
