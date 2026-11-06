import { type EventStatus } from '@prisma/client';
import { eventFinishesAt, type EventDayLike } from '../event/event-status.util.js';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { guestDocumentRepository } from '../guest-document/guest-document.repository.js';
import { resolveDocumentLimits, toDocumentStorageView, type DocumentStorageView } from '../guest-document/guest-document-allowance.util.js';
import { storageRetentionRepository } from './storage-retention.repository.js';
import { scheduledDocumentPurgeAt } from './storage-retention.types.js';
import { currentRetentionFloor } from './retention-state.util.js';

// ─────────────────────────────────────────
//  THE ORGANISER'S VIEW OF AN EVENT'S DOCUMENT STORAGE
//  (GET /api/events/:id, as `documentStorage`)
//
//  usedBytes and limitBytes come from exactly what an upload is held to
//  (guest-document-allowance.util.ts), so the warning can never disagree
//  with a refusal. nearLimit: over 80%. deletesAt: when the documents still
//  kept are deleted (30 days after cancelling, 90 after finishing, or a
//  week after a late reminder), null while there is no such date, none are
//  kept, or storageRetention is off.
// ─────────────────────────────────────────

export interface EventDocumentStorage extends DocumentStorageView {
  deletesAt: Date | null;
}

export const resolveEventDocumentStorage = async (
  event: EntitlementDerivableEvent & { id: string; status: EventStatus; isArchived: boolean; cancelledAt: Date | null; eventDays: EventDayLike[] },
  now: Date = new Date()
): Promise<EventDocumentStorage> => {
  const usedBytes = await guestDocumentRepository.sumLiveBytesForEvent(event.id);
  const { maxBytesPerEvent } = await resolveDocumentLimits(event);
  const view = toDocumentStorageView(usedBytes, maxBytesPerEvent);
  if (usedBytes === 0 || event.isArchived) return { ...view, deletesAt: null };

  // The status may already be the effective one (COMPLETED): the finish is
  // read from the days, as for a published event.
  const reason = event.status === 'CANCELLED' ? 'CANCELLED' as const : event.status === 'COMPLETED' ? 'FINISHED' as const : null;
  const startedAt = reason === 'CANCELLED' ? event.cancelledAt : reason === 'FINISHED' ? eventFinishesAt({ status: 'PUBLISHED', eventDays: event.eventDays }) : null;
  if (!reason || !startedAt) return { ...view, deletesAt: null };

  const claims = await storageRetentionRepository.findClaims(event.id);
  const deletesAt = scheduledDocumentPurgeAt(reason, startedAt, {
    remindedAt: claims.reminders.find((r) => r.reason === reason)?.claimedAt ?? null,
    claimedAt: claims.purges.find((p) => p.reason === reason)?.claimedAt ?? null,
  }, await currentRetentionFloor(now), now);
  return { ...view, deletesAt };
};
