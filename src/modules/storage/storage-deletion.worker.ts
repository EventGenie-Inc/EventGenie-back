import { destroyAsset } from '../../shared/cloudinary/cloudinary.client.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { storedFileRepository, type ClaimedFile } from './stored-file.repository.js';
import { storedFileService } from './stored-file.service.js';
import { storageReconciliationService } from './storage-reconciliation.service.js';
import { eventDraftService } from '../event-draft/event-draft.service.js';

// ─────────────────────────────────────────
//  THE STORAGE WORKER — the one place a requested deletion happens
//
//  Takes files marked DELETE_REQUESTED, a batch at a time, grouped by
//  resource and delivery type, and deletes each by its exact public id
//  (destroyAsset: the Upload API, with `invalidate`, so the CDN's copy
//  goes too). Never by folder. "Not found" is done: the file is gone.
//
//  A failure is retried with backoff (1, 2, 4 ... minutes, at most 6
//  hours apart), forever: a file is never given up on. Sentry hears on the
//  3rd failure in a row and every 10th after. Each batch is a lease (10
//  minutes), taken in one statement with SKIP LOCKED, so any number of
//  workers on any number of servers never delete the same file twice.
//
//  Behind `storageDeletion` (on unless switched off): off, nothing is
//  deleted, and requests keep piling up as rows to be deleted once it is
//  back on. Requests themselves are never switched off.
//
//  Not here: a guest document's file (guest-document.service.ts deletes
//  those, in its own recorded and retried batches, and closes the row)
//  and an archived event's Memory Hub media (media-retention.service.ts,
//  likewise). Both mark the StoredFile DELETED when they are done.
// ─────────────────────────────────────────

export const DELETE_BATCH_SIZE = 100;
export const DELETE_CONCURRENCY = 5;
export const DELETE_LEASE_MS = 10 * 60 * 1000;
export const MAX_BATCHES_PER_RUN = 10;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const STORAGE_SWEEP_INTERVAL_MS = 60 * 1000;
// After the documents sweep's first run.
export const STORAGE_SWEEP_FIRST_RUN_DELAY_MS = 4 * 60 * 1000;

// After `attempts` failures in a row: 1 minute, then doubling, at most 6 hours.
export const nextAttemptDelayMs = (attempts: number): number =>
  Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);

export const shouldReportFailure = (attempts: number): boolean => attempts === 3 || (attempts > 3 && attempts % 10 === 0);

const RESOURCE = { IMAGE: 'image', VIDEO: 'video', RAW: 'raw' } as const;
const DELIVERY = { UPLOAD: 'upload', PRIVATE: 'private' } as const;

export interface DeletionRunResult {
  skipped: boolean;
  deleted: number;
  failed: number;
}

const runLimited = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(lanes);
};

const deleteBatch = async (batch: ClaimedFile[], now: Date): Promise<{ deleted: number; failed: number }> => {
  // One resource and delivery type at a time, as Cloudinary's API is split.
  const groups = new Map<string, ClaimedFile[]>();
  for (const file of batch) {
    const key = `${file.resourceType}/${file.deliveryType}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  const done: string[] = [];
  let failed = 0;
  for (const files of groups.values()) {
    await runLimited(files, DELETE_CONCURRENCY, async (file) => {
      const result = await destroyAsset(file.publicId, RESOURCE[file.resourceType], {
        type: DELIVERY[file.deliveryType],
        // A private file has no public CDN copy to clear.
        invalidate: file.deliveryType === 'UPLOAD',
      });
      if (result.ok) {
        done.push(file.id);
        return;
      }
      failed++;
      const attempts = file.deleteAttempts + 1;
      const reason = result.reason ?? 'Unknown error';
      await storedFileRepository.recordFailure(file.id, attempts, new Date(now.getTime() + nextAttemptDelayMs(attempts)), reason);
      // Ids only: a public id can carry a document's file name.
      console.error(`[storage] deleting file ${file.id} failed (attempt ${attempts}): ${reason}`);
      if (shouldReportFailure(attempts)) {
        reportError(new Error(`[storage] file ${file.id} could not be deleted from Cloudinary after ${attempts} attempts, still retrying: ${reason}`));
      }
    });
  }
  const deleted = await storedFileRepository.markDeleted(done, now);
  return { deleted, failed };
};

export const storageDeletionWorker = {
  // Every file due, a batch at a time, up to MAX_BATCHES_PER_RUN batches.
  runOnce: async (now: Date = new Date()): Promise<DeletionRunResult> => {
    if (!isFeatureEnabled('storageDeletion')) return { skipped: true, deleted: 0, failed: 0 };
    let deleted = 0;
    let failed = 0;
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const batch = await storedFileRepository.claimDue(now, new Date(now.getTime() + DELETE_LEASE_MS), DELETE_BATCH_SIZE);
      if (batch.length === 0) break;
      const outcome = await deleteBatch(batch, now);
      deleted += outcome.deleted;
      failed += outcome.failed;
      if (batch.length < DELETE_BATCH_SIZE) break;
    }
    return { skipped: false, deleted, failed };
  },

  // These files now, if due (a released upload). Whatever fails stays
  // requested, for the next run. Never throws: the request is recorded.
  deleteNow: async (ids: string[], now: Date = new Date()): Promise<DeletionRunResult> => {
    if (ids.length === 0 || !isFeatureEnabled('storageDeletion')) return { skipped: true, deleted: 0, failed: 0 };
    try {
      const batch = await storedFileRepository.claimDue(now, new Date(now.getTime() + DELETE_LEASE_MS), DELETE_BATCH_SIZE, ids);
      if (batch.length === 0) return { skipped: false, deleted: 0, failed: 0 };
      return { skipped: false, ...(await deleteBatch(batch, now)) };
    } catch (err) {
      console.error('[storage] immediate delete failed, retried by the worker');
      reportError(err);
      return { skipped: false, deleted: 0, failed: ids.length };
    }
  },
};

// One pass of the storage sweep: wizard drafts untouched for 30 days
// deleted (their covers requested), unsaved uploads requested for
// deletion, then the worker, then the weekly reconciliation if one is due.
export const runStorageSweep = async (now: Date = new Date()): Promise<void> => {
  await eventDraftService.expireStale(now);
  await storedFileService.sweepUnsaved(now);
  await storageDeletionWorker.runOnce(now);
  await storageReconciliationService.runIfDue(now);
};

// Started by server.ts only, so tests start no timer. Never overlaps
// itself, never keeps the process alive. Returns a stop function.
export const startStorageSweeps = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runStorageSweep();
    } catch (err) {
      console.error('[storage] sweep failed');
      reportError(err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), STORAGE_SWEEP_FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), STORAGE_SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
