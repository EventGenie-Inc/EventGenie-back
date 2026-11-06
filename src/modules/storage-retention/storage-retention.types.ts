import { type DocumentRetentionReason } from '@prisma/client';
import { notBeforeFloor } from './retention-state.util.js';

// ─────────────────────────────────────────
//  STORAGE RETENTION: THE NUMBERS AND DATES, written once
//  (storage-retention.service.ts does the work; STEERING "Storage").
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// A cancelled event's documents: kept this long after cancelling.
export const CANCELLED_DOCUMENT_RETENTION_DAYS = 30;
// A finished event's documents: kept this long after it finished.
export const FINISHED_DOCUMENT_RETENTION_DAYS = 90;
// The organisers are emailed this long before either deletion, and the
// deletion always waits this long after the email went.
export const DOCUMENT_PURGE_REMINDER_DAYS_BEFORE = 7;

export const STORAGE_RETENTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// After the media retention's and the documents sweep's first runs.
export const STORAGE_RETENTION_SWEEP_FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
// Rejected and removed items claimed per run, a batch at a time.
export const ITEM_DELETION_BATCH_SIZE = 100;
export const ITEM_DELETION_MAX_BATCHES_PER_RUN = 10;

export type RemindedReason = Extract<DocumentRetentionReason, 'FINISHED' | 'CANCELLED'>;

export const retentionDaysFor = (reason: RemindedReason): number =>
  reason === 'CANCELLED' ? CANCELLED_DOCUMENT_RETENTION_DAYS : FINISHED_DOCUMENT_RETENTION_DAYS;

// When the documents go: N days after the clock started (finished, or
// cancelled), and never sooner than a week after the reminder went. A late
// reminder (the sweep down, the flag off) moves the deletion to a week
// after it: the date the email gives.
export const documentPurgeDueAt = (reason: RemindedReason, startedAt: Date, remindedAt: Date | null = null): Date =>
  new Date(Math.max(
    startedAt.getTime() + retentionDaysFor(reason) * DAY_MS,
    remindedAt ? remindedAt.getTime() + DOCUMENT_PURGE_REMINDER_DAYS_BEFORE * DAY_MS : 0
  ));

// When the reminder is due: a week before the N days are up.
export const documentPurgeReminderDueAt = (reason: RemindedReason, startedAt: Date): Date =>
  new Date(startedAt.getTime() + (retentionDaysFor(reason) - DOCUMENT_PURGE_REMINDER_DAYS_BEFORE) * DAY_MS);

// The organiser's countdown for an event's documents: the deletion's own
// time once claimed; else when it is scheduled (a week from now when the
// reminder is overdue and not yet sent: the earliest it can now be), and
// never before `floor` (retention-state.util.ts). Null while
// storageRetention is off (floor null): no countdown to a deletion that
// won't happen.
export const scheduledDocumentPurgeAt = (
  reason: RemindedReason,
  startedAt: Date,
  state: { remindedAt: Date | null; claimedAt: Date | null },
  floor: Date | null,
  now: Date = new Date()
): Date | null => {
  if (!floor) return null;
  if (state.claimedAt) return state.claimedAt;
  const due = state.remindedAt
    ? documentPurgeDueAt(reason, startedAt, state.remindedAt)
    : now >= documentPurgeReminderDueAt(reason, startedAt) ? documentPurgeDueAt(reason, startedAt, now) : documentPurgeDueAt(reason, startedAt);
  return notBeforeFloor(due, floor);
};

export interface StorageRetentionSweepResult {
  skipped: boolean;
  // Rejected or removed Memory Hub items whose files were requested.
  itemsClaimed: number;
  // Per event: documents requested, and why.
  documentPurges: { eventId: string; reason: DocumentRetentionReason; requestedCount: number }[];
  reminders: { eventId: string; reason: RemindedReason; recipientCount: number; failedCount: number }[];
}
