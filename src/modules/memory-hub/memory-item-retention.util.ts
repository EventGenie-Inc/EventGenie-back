import { HttpError } from '../../shared/errors/http-error.js';

// ─────────────────────────────────────────
//  REJECTED AND REMOVED MEMORY HUB ITEMS: DELETED 7 DAYS LATER
//
//  The rule, written once. An item the organiser rejected (rejectedAt) or
//  removed (archived; removedAt) has its file deleted MEMORY_ITEM_DELETION_DAYS
//  later, unless approved again or restored first, which clears that
//  clock. Rejected and removed: whichever came first. The sweep that does
//  it is storage-retention.service.ts; this file is the date every item
//  view reports (deletesAt), so the frontend shows the countdown without
//  keeping a copy of the number.
//
//  Once the deletion is claimed (purgedAt), approving or restoring is
//  refused: 409 MEMORY_ITEM_DELETED.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export const MEMORY_ITEM_DELETION_DAYS = 7;

export const MEMORY_ITEM_DELETED = 'MEMORY_ITEM_DELETED';

export const memoryItemDeleted = (): HttpError =>
  new HttpError(409, 'This photo or video has been permanently deleted, so it can no longer be approved or restored.', MEMORY_ITEM_DELETED);

export interface RetainableItem {
  status: string;
  isArchived: boolean;
  rejectedAt: Date | null;
  removedAt: Date | null;
  purgedAt: Date | null;
}

// When the item's file will be deleted: 7 days after it was rejected or
// removed (the earlier, while it is still so), and never before `floor`
// (7 days after the retention sweep last resumed: retention-state.util.ts).
// Null when it is kept, when its deletion has already been claimed (it is
// gone), and while storageRetention is off (floor null): no countdown to a
// deletion that won't happen.
export const memoryItemDeletesAt = (item: RetainableItem, floor: Date | null): Date | null => {
  if (!floor || item.purgedAt) return null;
  const starts = [
    item.status === 'REJECTED' ? item.rejectedAt : null,
    item.isArchived ? item.removedAt : null,
  ].filter((d): d is Date => d !== null);
  if (starts.length === 0) return null;
  const due = Math.min(...starts.map((d) => d.getTime())) + MEMORY_ITEM_DELETION_DAYS * DAY_MS;
  return new Date(Math.max(due, floor.getTime()));
};

// The cutoff the sweep uses: started at or before it, due now.
export const memoryItemDeletionCutoff = (now: Date): Date => new Date(now.getTime() - MEMORY_ITEM_DELETION_DAYS * DAY_MS);
