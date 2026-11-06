import { type PlatformRole } from '@prisma/client';
import { mediaRetentionRepository } from './media-retention.repository.js';
import { buildMediaPurgeReminderEmail } from './media-purge-reminder-email.util.js';
import {
  type MediaPurgeOutcome,
  type MediaPurgeReminderOutcome,
  type MediaPurgeView,
  type MediaRetentionSweepResult,
} from './media-retention.types.js';
import {
  MEDIA_PURGE_REMINDER_DAYS_BEFORE,
  MEDIA_RETENTION_DAYS,
  mediaPurgeDueAt,
  mediaPurgeReminderDueAt,
} from '../event/event-media-retention.util.js';
import { eventService } from '../event/event.service.js';
import { resolveEventOrganisers } from '../event-assignment/event-organisers.util.js';
import { isSignedPublicIdInAnyFolder, memoryHubFolders } from '../upload/upload-folders.js';
import { memoryHubRepository } from '../memory-hub/memory-hub.repository.js';
import { storedFileService } from '../storage/stored-file.service.js';
import { DELETE_BATCH_SIZE, storageDeletionWorker } from '../storage/storage-deletion.worker.js';
import { sendEmailBatch } from '../../shared/messaging/email.engine.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { guestDocumentService } from '../guest-document/guest-document.service.js';

// ─────────────────────────────────────────
//  ARCHIVED EVENTS: MEMORY HUB MEDIA DELETED AFTER 30 DAYS
//
//  Archiving an event used to keep its Memory Hub photos and videos in
//  Cloudinary forever. Now, MEDIA_RETENTION_DAYS after it was archived
//  (Event.archivedAt), they are deleted from Cloudinary and their
//  MemoryItem rows marked purged (purgedAt, and archived), never deleted.
//  The event, its cover photo and its invitation design are kept: only
//  items' own public ids are ever deleted, each checked against the event's
//  Memory Hub folder first. MEDIA_PURGE_REMINDER_DAYS_BEFORE that, its
//  organisers are emailed once, with a button to download them.
//
//  A periodic in-process sweep (startMediaRetentionSweeps, started by
//  server.ts), built like the feedback request's: the timer guarantees
//  nothing.
//
//  - CLAIMED ONCE. A purge is one EventMediaPurge row per event and
//    archiving, inserted under the event's row lock while it is still
//    archived and due. However many sweeps race, on one server or several,
//    one insert succeeds. A restore before the claim cancels the purge (the
//    event is no longer archived); after it, the event is restored without
//    its media.
//  - ONE SWEEP AT A TIME, THROUGH THE STORAGE WORKER. Working on a purge
//    takes its lease (a conditional write, so one sweep wins). Its items are
//    claimed in batches of DELETE_BATCH_SIZE: each batch marked purged (and
//    archived) with its files requested for deletion, in one transaction;
//    the storage worker deletes them (one by one, with invalidate), at once
//    (deleteNow) and then on its own schedule, retrying a failure with
//    backoff. The purge is complete when every one of its files is deleted;
//    until then each sweep records what is left (failedCount, lastError)
//    and asks again for any that are due. A purge that has begun always
//    finishes, a restore included, and only for the items that existed
//    when it began; a purged item can never be restored.
//  - THE REMINDER is claimed once per event and archiving
//    (MediaPurgeReminderClaim) before it is sent, like the feedback
//    request. Not for a restored event, one whose purge has begun (a super
//    admin's), or one with nothing to download. It catches up however late
//    (a server asleep, the flag off), and THE PURGE WAITS FOR IT: never
//    before MEDIA_PURGE_REMINDER_DAYS_BEFORE after the reminder went
//    (mediaPurgeDueAt), so a late reminder moves the purge to a week after
//    it, the date the email gives. Only an event with nothing to download
//    is purged without one, at 30 days.
//  - NOTHING IS IMMEDIATE AT DEPLOY. Events archived before archivedAt
//    existed were given the migration's time, so their 30 days start then.
//
//  A super admin can purge an archived event's media at once
//  (purgeNowAsSuperAdmin): the same claim and the same run, recorded with
//  who asked and when.
//
//  Behind `archiveMediaPurge` (on unless switched off): off, nothing is
//  reminded or deleted and the super admin purge is refused. Archiving
//  records archivedAt either way. Switched back on, an event archived more
//  than 30 days earlier is reminded on the next sweep and purged a week
//  after that.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export const MEDIA_RETENTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// The first sweep waits for the server to finish starting (after the
// feedback request's first sweep, so the two don't start together).
export const MEDIA_RETENTION_SWEEP_FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
// How long one attempt may hold a purge before another sweep may take it
// over: far longer than an attempt takes (a 30-second timeout per
// Cloudinary call), short enough that a crashed one is retried soon.
export const MEDIA_PURGE_LEASE_MS = 10 * 60 * 1000;

// Who MemoryItem.updatedBy names for a purge by the sweep.
const RETENTION_ACTOR = 'media-retention';

export const EVENT_NOT_ARCHIVED = 'EVENT_NOT_ARCHIVED';
export const MEDIA_PURGE_ALREADY_STARTED = 'MEDIA_PURGE_ALREADY_STARTED';
export const ARCHIVE_MEDIA_PURGE_OFF = 'ARCHIVE_MEDIA_PURGE_OFF';

// Shown on a purge whose files are waiting for the worker without having
// failed (storageDeletion off, or a lease held elsewhere).
const WAITING_FOR_WORKER = 'Waiting for the storage worker';

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const toView = (purge: {
  eventId: string;
  reason: MediaPurgeView['reason'];
  requestedBy: string | null;
  startedAt: Date;
  completedAt: Date | null;
  purgedCount: number;
  failedCount: number;
}): MediaPurgeView => ({
  eventId: purge.eventId,
  reason: purge.reason,
  requestedBy: purge.requestedBy,
  startedAt: purge.startedAt,
  completedAt: purge.completedAt,
  purgedCount: purge.purgedCount,
  failedCount: purge.failedCount,
});

export const mediaRetentionService = {
  // Claims and emails one event's reminder, or does nothing (null): not
  // due after all, restored, its purge already begun, nothing to download,
  // or already claimed.
  remindFor: async (eventId: string, now: Date = new Date()): Promise<MediaPurgeReminderOutcome | null> => {
    const event = await mediaRetentionRepository.findEventForReminder(eventId);
    if (!event || !event.isArchived || !event.archivedAt) return null;

    if (now < mediaPurgeReminderDueAt(event.archivedAt)) return null;
    if (await mediaRetentionRepository.purgeExists(event.id, event.archivedAt)) return null;
    if ((await mediaRetentionRepository.countDownloadableItems(event.id)) === 0) return null;

    // 30 days after archiving, or a week from now when this reminder is
    // late: the purge waits for the date the email gives.
    const purgeAt = mediaPurgeDueAt(event.archivedAt, now);
    const recipients = await resolveEventOrganisers(event);
    if (!(await mediaRetentionRepository.claimReminder(event.id, event.archivedAt, recipients.length, now))) return null;

    if (recipients.length === 0) {
      console.warn(`[media retention] event ${event.id} has no organiser to remind`);
      return { eventId: event.id, recipientCount: 0, failedCount: 0 };
    }

    const results = await sendEmailBatch(
      recipients.map((r) => buildMediaPurgeReminderEmail({ to: r.email, eventId: event.id, eventName: event.name, purgeAt }))
    );
    const failedCount = results.filter((r) => !r.ok).length;
    if (failedCount > 0) {
      // Counts only: an address never goes in a log line.
      console.error(`[media retention] ${failedCount} of ${recipients.length} reminder(s) for event ${event.id} failed to send`);
    }
    return { eventId: event.id, recipientCount: recipients.length, failedCount };
  },

  // One attempt at a purge, or null when it is finished or another sweep
  // holds it. Claims what is left of it a batch at a time (items marked
  // purged, their files requested, one transaction per batch), requests any
  // document still kept, then asks the storage worker to delete every file
  // of the purge still there and due. Complete once none is left.
  //
  // purgedCount: items (and documents) claimed by this attempt. failedCount:
  // files of the purge still not deleted after it, retried by the worker
  // and checked again by the next sweep.
  runPurge: async (purgeId: string, now: Date = new Date()): Promise<MediaPurgeOutcome | null> => {
    if (!(await mediaRetentionRepository.takeLease(purgeId, now, new Date(now.getTime() + MEDIA_PURGE_LEASE_MS)))) return null;

    const purge = await mediaRetentionRepository.findPurge(purgeId);
    const actor = purge.requestedBy ?? RETENTION_ACTOR;
    const owner = { tenantId: purge.event.tenantId, eventId: purge.eventId };
    let purgedCount = 0;
    let left: { id: string; lastDeleteError: string | null }[];

    try {
      const items = await mediaRetentionRepository.findItemsToPurge(purge.eventId, purge.startedAt);
      const folders = memoryHubFolders(purge.event.tenantId, purge.eventId);

      // Every stored id was checked on the way in; one that isn't in this
      // event's folder (an older row) is never sent to Cloudinary, since it
      // could name another event's asset. Its row is hidden all the same.
      const outside = items.filter((i) => !isSignedPublicIdInAnyFolder(i.cloudinaryPublicId, folders));
      if (outside.length > 0) {
        console.warn(`[media retention] event ${purge.eventId}: ${outside.length} item(s) outside its folder hidden, not deleted`);
        purgedCount += (await mediaRetentionRepository.markItemsPurged(outside.map((i) => i.id), now, actor)).count;
      }

      const inside = items.filter((i) => isSignedPublicIdInAnyFolder(i.cloudinaryPublicId, folders));
      for (const batch of chunk(inside, DELETE_BATCH_SIZE)) {
        purgedCount += await mediaRetentionRepository.withTransaction(async (tx) => {
          const claimed = await memoryHubRepository.claimItemsForDeletion(tx, { id: { in: batch.map((i) => i.id) } }, now, actor);
          await storedFileService.requestItemFiles(tx, claimed, owner, now);
          return claimed.length;
        });
      }

      // Its guests' uploaded documents too (guest-document.service.ts),
      // counted with the items. Archiving already requested them, so this
      // is the backstop for any left.
      purgedCount += await mediaRetentionRepository.withTransaction((tx) =>
        guestDocumentService.requestPurgeForEvent(tx, purge.eventId, purge.startedAt, now)
      );

      const outstanding = await mediaRetentionRepository.findOutstandingFiles(purge.eventId, purge.startedAt);
      await storageDeletionWorker.deleteNow(outstanding.map((f) => f.id), now);
      left = outstanding.length ? await mediaRetentionRepository.findOutstandingFiles(purge.eventId, purge.startedAt) : [];
    } catch (err) {
      // A database failure mid-run: release the lease so the next sweep
      // retries now, not when the lease runs out. Whatever was claimed is
      // requested, and the worker deletes it either way.
      await mediaRetentionRepository.finishAttempt(purgeId, {
        purgedCount,
        failedCount: purge.failedCount,
        lastError: err instanceof Error ? err.message : 'Unknown error',
        completedAt: null,
      });
      throw err;
    }

    const failedCount = left.length;
    const completed = failedCount === 0;
    const lastError = completed ? null : left.find((f) => f.lastDeleteError)?.lastDeleteError ?? WAITING_FOR_WORKER;
    await mediaRetentionRepository.finishAttempt(purgeId, { purgedCount, failedCount, lastError, completedAt: completed ? now : null });
    if (!completed) {
      // Counts only. The worker reports a file that keeps failing to Sentry
      // itself (the 3rd failure in a row, and every 10th after).
      console.warn(`[media retention] ${failedCount} file(s) of event ${purge.eventId} not deleted yet, checked again next sweep`);
    }
    return { purgeId, eventId: purge.eventId, reason: purge.reason, purgedCount, failedCount, completed };
  },

  // One pass: reminders due, purges due claimed, then every unfinished
  // purge no other sweep holds (the new ones and earlier failures).
  // With `archiveMediaPurge` off it does nothing at all: no reminder, no new
  // purge, and no retry of one already begun.
  sweep: async (now: Date = new Date()): Promise<MediaRetentionSweepResult> => {
    const result: MediaRetentionSweepResult = { reminders: [], purges: [] };
    if (!isFeatureEnabled('archiveMediaPurge')) return result;
    const purgeFrom = new Date(now.getTime() - MEDIA_RETENTION_DAYS * DAY_MS);
    const remindFrom = new Date(purgeFrom.getTime() + MEDIA_PURGE_REMINDER_DAYS_BEFORE * DAY_MS);
    // A purge also waits a full week after its reminder.
    const remindedBy = new Date(now.getTime() - MEDIA_PURGE_REMINDER_DAYS_BEFORE * DAY_MS);

    for (const eventId of await mediaRetentionRepository.findReminderCandidates(remindFrom)) {
      try {
        const outcome = await mediaRetentionService.remindFor(eventId, now);
        if (outcome) result.reminders.push(outcome);
      } catch (err) {
        // One event failing never stops the others.
        console.error(`[media retention] reminder for event ${eventId} failed:`, err);
        reportError(err);
      }
    }

    for (const eventId of await mediaRetentionRepository.findDuePurgeEventIds(purgeFrom, remindedBy)) {
      try {
        await mediaRetentionRepository.claimPurge(eventId, { reason: 'RETENTION', requestedBy: null, dueBy: purgeFrom, now });
      } catch (err) {
        console.error(`[media retention] claiming the purge of event ${eventId} failed:`, err);
        reportError(err);
      }
    }

    for (const purgeId of await mediaRetentionRepository.findPurgesToRun(now)) {
      try {
        const outcome = await mediaRetentionService.runPurge(purgeId, now);
        if (outcome) result.purges.push(outcome);
      } catch (err) {
        console.error(`[media retention] purge ${purgeId} failed:`, err);
        reportError(err);
      }
    }
    return result;
  },

  // POST /api/admin/events/:eventId/media-purge (SUPER_ADMIN only): an
  // archived event's media deleted now, through the sweep's own claim and
  // run, recorded with who asked (requestedBy) and when (startedAt). Any
  // tenant's event; a missing one is 404.
  // With `archiveMediaPurge` off: 422 ARCHIVE_MEDIA_PURGE_OFF, checked
  // before anything else, deleting nothing. (The route answers a super admin
  // only, and a switched-off feature never hides from one, so the refusal
  // is here rather than a requireFeature 404.)
  purgeNowAsSuperAdmin: async (eventId: string, userId: string, requestingRole: PlatformRole): Promise<MediaPurgeView> => {
    if (!isFeatureEnabled('archiveMediaPurge')) {
      throw new HttpError(422, "Deleting archived events' photos and videos is switched off on this server.", ARCHIVE_MEDIA_PURGE_OFF);
    }
    await eventService.getScoped(eventId, requestingRole, null, true);

    const now = new Date();
    const claim = await mediaRetentionRepository.claimPurge(eventId, { reason: 'SUPER_ADMIN', requestedBy: userId, dueBy: null, now });
    if (claim.outcome === 'NOT_ARCHIVED' || claim.outcome === 'NOT_DUE') {
      throw new HttpError(409, 'Archive this event before deleting its photos and videos.', EVENT_NOT_ARCHIVED);
    }
    if (claim.outcome === 'EXISTS') {
      throw new HttpError(
        409,
        claim.purge.completedAt
          ? `This event's photos and videos were already deleted on ${formatGuestDate(claim.purge.completedAt)}.`
          : "This event's photos and videos are already being deleted. Any that failed are tried again every 15 minutes.",
        MEDIA_PURGE_ALREADY_STARTED
      );
    }

    // Null only if a sweep took the lease first: it is running now.
    await mediaRetentionService.runPurge(claim.purge.id, now);
    const purge = await mediaRetentionRepository.findPurgeForEvent(eventId, claim.purge.archivedAt);
    return toView(purge ?? claim.purge);
  },
};

// Starts the periodic sweep: once shortly after startup, then every
// MEDIA_RETENTION_SWEEP_INTERVAL_MS. A sweep still running when the next is
// due is not overlapped. The timers don't keep the process alive. Returns a
// stop function.
export const startMediaRetentionSweeps = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await mediaRetentionService.sweep();
    } catch (err) {
      console.error('[media retention] sweep failed:', err);
      reportError(err);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void run(), MEDIA_RETENTION_SWEEP_FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), MEDIA_RETENTION_SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
