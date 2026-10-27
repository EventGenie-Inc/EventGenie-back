// ─────────────────────────────────────────
//  ARCHIVED EVENTS: WHEN THEIR MEMORY HUB MEDIA IS DELETED
//
//  The rule, written once: an archived event's Memory Hub photos and videos
//  are deleted from Cloudinary MEDIA_RETENTION_DAYS after it was archived
//  (Event.archivedAt), and its organisers are emailed
//  MEDIA_PURGE_REMINDER_DAYS_BEFORE that. The sweep that does it is
//  media-retention.service.ts; this file is only the dates and the fields
//  every event view reports (withMediaRetention), so the frontend can show
//  the countdown without keeping a copy of the numbers.
// ─────────────────────────────────────────

import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const MEDIA_RETENTION_DAYS = 30;
export const MEDIA_PURGE_REMINDER_DAYS_BEFORE = 7;

// When an archived event's media may be purged: MEDIA_RETENTION_DAYS after
// it was archived, and never sooner than MEDIA_PURGE_REMINDER_DAYS_BEFORE
// after its reminder went (remindedAt). A late reminder (the sweep down,
// or `archiveMediaPurge` off past the 30 days) pushes the purge back, so
// the organisers always get their full week to download. An event with
// nothing to download needs no reminder; the sweep purges it at 30 days.
export const mediaPurgeDueAt = (archivedAt: Date, remindedAt: Date | null = null): Date =>
  new Date(Math.max(
    archivedAt.getTime() + MEDIA_RETENTION_DAYS * DAY_MS,
    remindedAt ? remindedAt.getTime() + MEDIA_PURGE_REMINDER_DAYS_BEFORE * DAY_MS : 0
  ));

// When the reminder is due: a week before the 30 days are up.
export const mediaPurgeReminderDueAt = (archivedAt: Date): Date =>
  new Date(archivedAt.getTime() + (MEDIA_RETENTION_DAYS - MEDIA_PURGE_REMINDER_DAYS_BEFORE) * DAY_MS);

// What an event read includes to report its purges: every purge and every
// reminder (one each per archiving, so a handful at most), newest first.
export const MEDIA_PURGES_INCLUDE = {
  mediaPurges: {
    select: { archivedAt: true, startedAt: true, completedAt: true },
    orderBy: { startedAt: 'desc' },
  },
  mediaPurgeReminderClaims: {
    select: { archivedAt: true, claimedAt: true },
  },
} as const;

interface MediaPurgeSummary {
  archivedAt: Date;
  startedAt: Date;
  completedAt: Date | null;
}

export interface MediaRetentionFields {
  // When it was archived; null while live.
  archivedAt: Date | null;
  // While archived: when its Memory Hub media is (or was) deleted. The
  // purge's own start once one has begun (a super admin's can be early);
  // else mediaPurgeDueAt: 30 days after archiving, or 7 days after a late
  // reminder. With the reminder overdue but not yet sent (the next sweep
  // sends it), the earliest it can now be: 7 days from now. Null while
  // live, and while `archiveMediaPurge` is off unless a purge has already
  // begun: no countdown to a deletion that won't happen.
  mediaPurgeAt: Date | null;
  // When its media was last deleted completely, archived or since restored
  // (a restored event comes back without it); null if never.
  mediaPurgedAt: Date | null;
}

const scheduledPurgeAt = (archivedAt: Date, remindedAt: Date | null, now: Date): Date | null => {
  if (!isFeatureEnabled('archiveMediaPurge')) return null;
  if (remindedAt) return mediaPurgeDueAt(archivedAt, remindedAt);
  return now >= mediaPurgeReminderDueAt(archivedAt) ? mediaPurgeDueAt(archivedAt, now) : mediaPurgeDueAt(archivedAt);
};

// Presenter: the three fields in place of the purge and reminder rows.
export const withMediaRetention = <T extends {
  isArchived: boolean;
  archivedAt: Date | null;
  mediaPurges: MediaPurgeSummary[];
  mediaPurgeReminderClaims: { archivedAt: Date; claimedAt: Date }[];
}>(
  event: T,
  now: Date = new Date()
): Omit<T, 'mediaPurges' | 'mediaPurgeReminderClaims' | 'archivedAt'> & MediaRetentionFields => {
  const { mediaPurges, mediaPurgeReminderClaims, archivedAt, ...rest } = event;
  const archivedSince = event.isArchived ? archivedAt : null;
  const ofThisArchiving = <R extends { archivedAt: Date }>(rows: R[]) =>
    archivedSince ? rows.find((r) => r.archivedAt.getTime() === archivedSince.getTime()) : undefined;
  const current = ofThisArchiving(mediaPurges);
  const reminder = ofThisArchiving(mediaPurgeReminderClaims);
  const completed = mediaPurges.find((p) => p.completedAt !== null);
  return {
    ...rest,
    archivedAt: archivedSince,
    mediaPurgeAt: !archivedSince
      ? null
      : current?.startedAt ?? scheduledPurgeAt(archivedSince, reminder?.claimedAt ?? null, now),
    mediaPurgedAt: completed?.completedAt ?? null,
  };
};
