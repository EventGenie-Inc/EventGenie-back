import { type DocumentRetentionReason } from '@prisma/client';
import { storageRetentionRepository, archivedOwnerDocumentsWhere } from './storage-retention.repository.js';
import { buildDocumentPurgeReminderEmail } from './document-purge-reminder-email.util.js';
import {
  DOCUMENT_PURGE_REMINDER_DAYS_BEFORE,
  ITEM_DELETION_BATCH_SIZE,
  ITEM_DELETION_MAX_BATCHES_PER_RUN,
  STORAGE_RETENTION_SWEEP_FIRST_RUN_DELAY_MS,
  STORAGE_RETENTION_SWEEP_INTERVAL_MS,
  documentPurgeDueAt,
  documentPurgeReminderDueAt,
  retentionDaysFor,
  type RemindedReason,
  type StorageRetentionSweepResult,
} from './storage-retention.types.js';
import { eventFinishesAt } from '../event/event-status.util.js';
import { resolveEventOrganisers } from '../event-assignment/event-organisers.util.js';
import { guestDocumentService } from '../guest-document/guest-document.service.js';
import { memoryHubRepository } from '../memory-hub/memory-hub.repository.js';
import { memoryItemDeletionCutoff } from '../memory-hub/memory-item-retention.util.js';
import { mediaRetentionRepository } from '../media-retention/media-retention.repository.js';
import { isSignedPublicIdInAnyFolder, memoryHubFolders } from '../upload/upload-folders.js';
import { storedFileService } from '../storage/stored-file.service.js';
import { storageDeletionWorker } from '../storage/storage-deletion.worker.js';
import { notBeforeFloor, retentionFloor, retentionStateRepository } from './retention-state.util.js';
import { sendEmailBatch } from '../../shared/messaging/email.engine.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';

// ─────────────────────────────────────────
//  STORAGE RETENTION (STEERING "Storage")
//
//  The rules that delete files nobody asked to delete one by one. Every
//  one only REQUESTS deletion, in the same transaction as its claim; the
//  storage worker (storage-deletion.worker.ts) deletes the files, at once
//  where it can (deleteNow) and on its own schedule after, retrying a
//  failure with backoff.
//
//  1. REJECTED AND REMOVED MEMORY HUB ITEMS, 7 days after the organiser
//     rejected (rejectedAt) or removed (removedAt) them, unless approved or
//     restored first (memory-item-retention.util.ts). The claim marks the
//     item purged in one UPDATE whose WHERE re-checks the rule, so an
//     approve or restore racing it either lands first (the item no longer
//     matches) or is refused, 409 MEMORY_ITEM_DELETED.
//  2. DOCUMENTS OF ARCHIVED GUESTS, INVITES AND QUESTIONS, when the event
//     finishes (the end of its last day, event-status.util.ts's
//     eventFinishesAt). Archiving one deletes nothing; restoring before the
//     finish brings the documents back.
//  3. A CANCELLED EVENT'S DOCUMENTS, all of them, 30 days after it was
//     cancelled (cancelledAt).
//  4. A FINISHED EVENT'S DOCUMENTS, the rest, 90 days after it finished.
//     Whichever deletion comes first (this, 2, 3, or the archived event's
//     purge) wins: each requests only what is still kept.
//  5. AN ARCHIVED EVENT'S DOCUMENTS go with its Memory Hub media purge, 30
//     days after archiving (media-retention.service.ts). A purge that
//     couldn't delete them (this flag off, or within a resume's 7 days)
//     leaves them; this sweep requests them once it may.
//
//  CLAIMED ONCE. Each document rule is one EventDocumentPurge row per event
//  and rule, inserted under the event's row lock with the event re-checked
//  (still finished, still cancelled) and the deletion requested in the same
//  transaction. A guest's or invite's restore takes the same lock, so it
//  lands either before the claim (its documents are no longer an archived
//  owner's: kept) or after (they are already requested).
//
//  THE REMINDER for 3 and 4 is claimed once per event and rule
//  (DocumentPurgeReminderClaim) before it is sent, to the event's
//  organisers, a week before. Not for an event with nothing left to delete.
//  It catches up however late, and THE DELETION WAITS FOR IT: never before
//  a full week after it went (documentPurgeDueAt), the date the email gives.
//
//  NOTHING IS IMMEDIATE AT DEPLOY. Items already rejected or removed, and
//  events already cancelled, were given the migration's time.
//
//  Behind `storageRetention` (on unless switched off): off, nothing here
//  deletes anything or emails anyone, and no countdown is reported. The
//  clocks are still recorded. NEVER WITHOUT A FULL COUNTDOWN: switched back
//  on (or the sweep not run for a while), it records a resume, and nothing
//  is deleted until 7 days after it (retention-state.util.ts): every rule's
//  date is the later of its own and that floor, as every deletesAt and
//  reminder reports. Reminders still go during those 7 days.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// Who MemoryItem.updatedBy names for an item the 7-day rule deleted.
const RETENTION_ACTOR = 'storage-retention';

const REMINDED_REASONS: RemindedReason[] = ['CANCELLED', 'FINISHED'];

type RetentionEvent = NonNullable<Awaited<ReturnType<typeof storageRetentionRepository.findEvent>>>;

// When the rule's clock started for this event, re-checked at claim time:
// null when it no longer applies (not finished, or not cancelled).
const clockStartedAt = (event: RetentionEvent, reason: DocumentRetentionReason): Date | null =>
  reason === 'CANCELLED'
    ? (event.status === 'CANCELLED' ? event.cancelledAt : null)
    : eventFinishesAt(event);

export const storageRetentionService = {

  // ── 1. Rejected and removed Memory Hub items ──

  // Claims every item due (a batch at a time): purged, and its file
  // requested, in one transaction per batch. An item outside its event's
  // folder (an older row) is closed without being sent. Returns the files
  // requested, for an immediate delete, and the number of items claimed.
  claimItemsDue: async (now: Date): Promise<{ claimed: number; fileIds: string[] }> => {
    const due = storageRetentionRepository.itemsDueWhere(memoryItemDeletionCutoff(now));
    let claimed = 0;
    const fileIds: string[] = [];
    for (let i = 0; i < ITEM_DELETION_MAX_BATCHES_PER_RUN; i++) {
      const batch = await storageRetentionRepository.findItemsDue(due, ITEM_DELETION_BATCH_SIZE);
      if (batch.length === 0) break;

      const inFolder = (item: (typeof batch)[number]) =>
        isSignedPublicIdInAnyFolder(item.cloudinaryPublicId, memoryHubFolders(item.memoryHub.event.tenantId, item.memoryHub.eventId));
      const outside = batch.filter((item) => !inFolder(item));
      if (outside.length > 0) {
        console.warn(`[storage retention] ${outside.length} item(s) outside their folder hidden, not deleted`);
        // Re-checked: only items still due are closed.
        const stillDue = await storageRetentionRepository.findItemsDue({ AND: [due, { id: { in: outside.map((o) => o.id) } }] }, outside.length);
        claimed += (await mediaRetentionRepository.markItemsPurged(stillDue.map((o) => o.id), now, RETENTION_ACTOR)).count;
      }

      const inside = batch.filter(inFolder);
      const owners = new Map(inside.map((item) => [item.id, { tenantId: item.memoryHub.event.tenantId, eventId: item.memoryHub.eventId }]));
      if (inside.length > 0) {
        const outcome = await storageRetentionRepository.withTransaction(async (tx) => {
          // The rule again, in the claim's own WHERE: an item approved or
          // restored since it was read is left alone.
          const items = await memoryHubRepository.claimItemsForDeletion(tx, { AND: [due, { id: { in: inside.map((item) => item.id) } }] }, now, RETENTION_ACTOR);
          const ids: string[] = [];
          for (const item of items) ids.push(...(await storedFileService.requestItemFiles(tx, [item], owners.get(item.id)!, now)));
          return { count: items.length, ids };
        });
        claimed += outcome.count;
        fileIds.push(...outcome.ids);
      }
      if (batch.length < ITEM_DELETION_BATCH_SIZE) break;
    }
    return { claimed, fileIds };
  },

  // ── 2-4. Documents ────────────────────────

  // Claims one event's deletion for one rule, under its row lock, with the
  // event re-checked at `now`, and requests the documents in the same
  // transaction. Null when it no longer applies or another sweep claimed it.
  claimDocumentPurge: async (eventId: string, reason: DocumentRetentionReason, now: Date): Promise<{ requestedCount: number } | null> =>
    storageRetentionRepository.withTransaction(async (tx) => {
      await storageRetentionRepository.lockEvent(tx, eventId);
      const event = await storageRetentionRepository.findEvent(eventId, tx);
      if (!event) return null;
      const startedAt = clockStartedAt(event, reason);
      if (!startedAt) return null;
      const daysAfter = reason === 'ARCHIVED_AT_FINISH' ? 0 : retentionDaysFor(reason);
      if (startedAt.getTime() + daysAfter * DAY_MS > now.getTime()) return null;
      if (!(await storageRetentionRepository.claimPurge(tx, eventId, reason, now))) return null;

      // Still archived NOW, under the lock: a guest or invite restored a
      // moment ago keeps its documents.
      const where = reason === 'ARCHIVED_AT_FINISH' ? archivedOwnerDocumentsWhere(eventId) : { eventId };
      const requestedCount = await guestDocumentService.requestDeletion(tx, where, now);
      await storageRetentionRepository.recordRequested(tx, eventId, reason, requestedCount);
      return { requestedCount };
    }),

  // Claims and emails one event's reminder, or does nothing (null): not due
  // after all, nothing left to delete, or already claimed.
  remindFor: async (eventId: string, reason: RemindedReason, now: Date, floor: Date) => {
    const event = await storageRetentionRepository.findEvent(eventId);
    if (!event) return null;
    const startedAt = clockStartedAt(event, reason);
    if (!startedAt || now < documentPurgeReminderDueAt(reason, startedAt)) return null;
    if ((await storageRetentionRepository.countLiveDocuments(eventId)) === 0) return null;

    // N days after the clock started, or a week from now when this
    // reminder is late: the deletion waits for the date the email gives.
    // Never before the floor: the date the deletion will really happen.
    const purgeAt = notBeforeFloor(documentPurgeDueAt(reason, startedAt, now), floor);
    const recipients = await resolveEventOrganisers(event);
    if (!(await storageRetentionRepository.claimReminder(eventId, reason, recipients.length, now))) return null;

    if (recipients.length === 0) {
      console.warn(`[storage retention] event ${eventId} has no organiser to remind`);
      return { eventId, reason, recipientCount: 0, failedCount: 0 };
    }
    const results = await sendEmailBatch(
      recipients.map((r) => buildDocumentPurgeReminderEmail({ to: r.email, eventId, eventName: event.name, reason, purgeAt }))
    );
    const failedCount = results.filter((r) => !r.ok).length;
    if (failedCount > 0) {
      // Counts only: an address never goes in a log line.
      console.error(`[storage retention] ${failedCount} of ${recipients.length} reminder(s) for event ${eventId} failed to send`);
    }
    return { eventId, reason, recipientCount: recipients.length, failedCount };
  },

  // One pass, in order: items due; documents of archived owners at the
  // finish; reminders due; deletions due. Then the worker is asked to
  // delete what was requested. One event failing never stops the others.
  // With storageRetention off it does nothing at all.
  sweep: async (now: Date = new Date()): Promise<StorageRetentionSweepResult> => {
    const result: StorageRetentionSweepResult = { skipped: true, itemsClaimed: 0, documentPurges: [], archivedEventDocuments: [], reminders: [] };
    if (!isFeatureEnabled('storageRetention')) return result;
    result.skipped = false;

    // Within 7 days of a resume, nothing is due: only reminders go.
    const floor = retentionFloor(await retentionStateRepository.recordSweep(now), now);
    const deleting = now >= floor;

    const fileIds: string[] = [];
    if (deleting) {
      try {
        const items = await storageRetentionService.claimItemsDue(now);
        result.itemsClaimed = items.claimed;
        fileIds.push(...items.fileIds);
      } catch (err) {
        console.error('[storage retention] claiming rejected and removed items failed');
        reportError(err);
      }
    }

    const claim = async (eventId: string, reason: DocumentRetentionReason): Promise<void> => {
      try {
        const outcome = await storageRetentionService.claimDocumentPurge(eventId, reason, now);
        if (outcome) result.documentPurges.push({ eventId, reason, requestedCount: outcome.requestedCount });
      } catch (err) {
        console.error(`[storage retention] the ${reason} deletion of event ${eventId}'s documents failed`);
        reportError(err);
      }
    };

    // 5. What an archived event's purge had to leave.
    for (const purge of deleting ? await storageRetentionRepository.findPurgesWithDocumentsLeft() : []) {
      try {
        const requestedCount = await storageRetentionRepository.withTransaction((tx) =>
          guestDocumentService.requestPurgeForEvent(tx, purge.eventId, purge.startedAt, now)
        );
        if (requestedCount > 0) result.archivedEventDocuments.push({ eventId: purge.eventId, requestedCount });
      } catch (err) {
        console.error(`[storage retention] the archived event ${purge.eventId}'s documents failed`);
        reportError(err);
      }
    }

    for (const eventId of deleting ? await storageRetentionRepository.findEventsDue('ARCHIVED_AT_FINISH', now) : []) {
      await claim(eventId, 'ARCHIVED_AT_FINISH');
    }

    for (const reason of REMINDED_REASONS) {
      const days = retentionDaysFor(reason);
      const purgeFrom = new Date(now.getTime() - days * DAY_MS);
      const remindFrom = new Date(purgeFrom.getTime() + DOCUMENT_PURGE_REMINDER_DAYS_BEFORE * DAY_MS);
      // A deletion also waits a full week after its reminder.
      const remindedBy = new Date(now.getTime() - DOCUMENT_PURGE_REMINDER_DAYS_BEFORE * DAY_MS);

      for (const eventId of await storageRetentionRepository.findReminderCandidates(reason, remindFrom)) {
        try {
          const outcome = await storageRetentionService.remindFor(eventId, reason, now, floor);
          if (outcome) result.reminders.push(outcome);
        } catch (err) {
          console.error(`[storage retention] the ${reason} reminder for event ${eventId} failed`);
          reportError(err);
        }
      }
      for (const eventId of deleting ? await storageRetentionRepository.findPurgesDue(reason, purgeFrom, remindedBy) : []) {
        await claim(eventId, reason);
      }
    }

    for (const purge of [...result.documentPurges, ...result.archivedEventDocuments]) {
      await guestDocumentService.deleteRequestedNow({ eventId: purge.eventId }, now);
    }
    await storageDeletionWorker.deleteNow(fileIds, now);
    return result;
  },
};

// Started by server.ts only, so tests start no timer: shortly after
// startup, then every STORAGE_RETENTION_SWEEP_INTERVAL_MS, never
// overlapping itself, never keeping the process alive. Returns a stop
// function.
export const startStorageRetentionSweeps = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await storageRetentionService.sweep();
    } catch (err) {
      console.error('[storage retention] sweep failed');
      reportError(err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), STORAGE_RETENTION_SWEEP_FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), STORAGE_RETENTION_SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
