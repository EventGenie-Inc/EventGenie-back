import { type EventStatus } from '@prisma/client';
import { eventFinishesAt, type EventDayLike } from '../event/event-status.util.js';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { guestDocumentRepository } from '../guest-document/guest-document.repository.js';
import { resolveDocumentLimits, toDocumentStorageView, type DocumentStorageView } from '../guest-document/guest-document-allowance.util.js';
import { storageRetentionRepository } from './storage-retention.repository.js';
import { scheduledDocumentPurgeAt } from './storage-retention.types.js';
import { currentRetentionFloor, notBeforeFloor } from './retention-state.util.js';

// ─────────────────────────────────────────
//  THE ORGANISER'S VIEW OF AN EVENT'S DOCUMENT STORAGE
//  (GET /api/events/:id, as `documentStorage`)
//
//  usedBytes and limitBytes come from exactly what an upload is held to
//  (guest-document-allowance.util.ts), so the warning can never disagree
//  with a refusal. nearLimit: over 80%. documentCount: the guests' answered
//  documents still kept (what the organiser can open; usedBytes also counts
//  an upload not yet sent with its RSVP), for the warning before archiving.
//  deletesAt: when the documents still kept are deleted, the earliest of
//  the rules that apply: an archived event's media purge (its mediaPurgeAt),
//  30 days after cancelling, 90 after finishing, each moved by a late
//  reminder and held to the retention floor. Null while there is no such
//  date, none are kept, or storageRetention is off.
// ─────────────────────────────────────────

export interface EventDocumentStorage extends DocumentStorageView {
  documentCount: number;
  deletesAt: Date | null;
}

export const resolveEventDocumentStorage = async (
  event: EntitlementDerivableEvent & {
    id: string;
    status: EventStatus;
    isArchived: boolean;
    cancelledAt: Date | null;
    eventDays: EventDayLike[];
    // withMediaRetention's: while archived, when its media purge is (or
    // was) due; null while live or archiveMediaPurge is off.
    mediaPurgeAt: Date | null;
  },
  now: Date = new Date()
): Promise<EventDocumentStorage> => {
  const usedBytes = await guestDocumentRepository.sumLiveBytesForEvent(event.id);
  const documentCount = usedBytes === 0 ? 0 : await guestDocumentRepository.countKeptAttachedForEvent(event.id);
  const { maxBytesPerEvent } = await resolveDocumentLimits(event);
  const view = { ...toDocumentStorageView(usedBytes, maxBytesPerEvent), documentCount };
  if (usedBytes === 0) return { ...view, deletesAt: null };
  const floor = await currentRetentionFloor(now);
  if (!floor) return { ...view, deletesAt: null };

  const dates: Date[] = [];
  // Archived: with its photos, held to the floor (the purge leaves the
  // documents until then; the storage retention sweep takes them after).
  if (event.isArchived && event.mediaPurgeAt) dates.push(notBeforeFloor(event.mediaPurgeAt, floor));

  // The status may already be the effective one (COMPLETED): the finish is
  // read from the days, as for a published event.
  const reason = event.status === 'CANCELLED' ? 'CANCELLED' as const : event.status === 'COMPLETED' ? 'FINISHED' as const : null;
  const startedAt = reason === 'CANCELLED' ? event.cancelledAt : reason === 'FINISHED' ? eventFinishesAt({ status: 'PUBLISHED', eventDays: event.eventDays }) : null;
  if (reason && startedAt) {
    const claims = await storageRetentionRepository.findClaims(event.id);
    const due = scheduledDocumentPurgeAt(reason, startedAt, {
      remindedAt: claims.reminders.find((r) => r.reason === reason)?.claimedAt ?? null,
      claimedAt: claims.purges.find((p) => p.reason === reason)?.claimedAt ?? null,
    }, floor, now);
    if (due) dates.push(due);
  }
  const deletesAt = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
  return { ...view, deletesAt };
};
