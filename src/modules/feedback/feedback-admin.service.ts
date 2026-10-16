import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { consentService, consentStateOf } from '../consent/consent.service.js';
import { EVENT_CONSENT_KINDS, type ConsentState, type EventConsentKind } from '../consent/consent.types.js';
import { feedbackRepository } from './feedback.repository.js';
import { isPhotoShareable, selectedPhotoIdsOf } from './feedback-photos.util.js';
import { buildArchiveDownloadUrl } from '../../shared/cloudinary/cloudinary-archive.util.js';
import { DOWNLOAD_LINK_TTL_MS, archiveNameFor, packArchiveParts } from '../memory-hub/memory-hub-download.service.js';

// ─────────────────────────────────────────
//  SUPER ADMIN — every event's feedback, and what may be shared
//
//  /api/admin/feedback (feedback-admin.router.ts): SUPER_ADMIN only, the
//  global 404 for everyone else. Read-only: nothing here records consent.
//
//  A permission is shown as its current state (the latest record): GRANTED
//  with when it was given and the wording version, WITHDRAWN with when, plus
//  the grant it withdrew, or NOT_GIVEN.
//
//  SHAREABLE photos are exactly feedback-photos.util.ts's isPhotoShareable:
//  approved, live, the guest's opt-in granted and the organiser's selection
//  granted, now. Their download links are the Memory Hub download's
//  (signed Cloudinary zip links of the originals, 30 minutes).
// ─────────────────────────────────────────

const toPermission = (state: ConsentState) => ({
  status: state.status,
  givenAt: state.givenAt,
  wordingVersion: state.wordingVersion,
  withdrawnAt: state.withdrawnAt,
});

type PermissionView = ReturnType<typeof toPermission>;

export interface FeedbackListEntry {
  eventId: string;
  eventName: string;
  // The event's first and last live days (null for an event with none).
  eventStartDate: Date | null;
  eventEndDate: Date | null;
  tenantId: string;
  companyName: string;
  submittedAt: Date;
  updatedAt: Date;
  score: number;
  workedBest: string | null;
  toImprove: string | null;
  logoUrl: string | null;
  permissions: Record<EventConsentKind, PermissionView>;
  photos: { selectedCount: number; shareableCount: number };
}

export const feedbackAdminService = {
  list: async (): Promise<FeedbackListEntry[]> => {
    const feedbacks = await feedbackRepository.findAllWithEvent();
    const eventIds = feedbacks.map((f) => f.eventId);
    const [statesByEvent, photos] = await Promise.all([
      consentService.statesForEvents(eventIds),
      feedbackRepository.findApprovedGuestPhotos(eventIds),
    ]);

    return feedbacks.map((f) => {
      const states = statesByEvent.get(f.eventId) ?? new Map<string, ConsentState>();
      const ctx = { tenantId: f.tenantId, eventId: f.eventId, states };
      const days = f.event.eventDays;
      return {
        eventId: f.eventId,
        eventName: f.event.name,
        eventStartDate: days[0]?.date ?? null,
        eventEndDate: days[days.length - 1]?.date ?? null,
        tenantId: f.tenantId,
        companyName: f.tenant.name,
        submittedAt: f.submittedAt,
        updatedAt: f.updatedAt,
        score: f.score,
        workedBest: f.workedBest,
        toImprove: f.toImprove,
        logoUrl: f.logoUrl,
        permissions: Object.fromEntries(
          EVENT_CONSENT_KINDS.map((kind) => [kind, toPermission(consentStateOf(states, kind))])
        ) as Record<EventConsentKind, PermissionView>,
        photos: {
          selectedCount: selectedPhotoIdsOf(states).length,
          shareableCount: photos.filter((p) => p.memoryHub.eventId === f.eventId && isPhotoShareable(p, ctx)).length,
        },
      };
    });
  },

  shareablePhotos: async (eventId: string) => {
    const event = await eventService.getScoped(eventId, 'SUPER_ADMIN', null);
    const [feedback, states, candidates] = await Promise.all([
      feedbackRepository.findByEventId(event.id),
      consentService.statesForEvent(event.id),
      feedbackRepository.findApprovedGuestPhotos([event.id]),
    ]);
    if (!feedback) throw new HttpError(404, 'This event has no feedback yet.');

    const ctx = { tenantId: event.tenantId, eventId: event.id, states };
    const photos = candidates.filter((p) => isPhotoShareable(p, ctx));

    let download: { expiresAt: string; parts: { part: number; partCount: number; itemCount: number; bytes: number; fileName: string; url: string }[] } | null = null;
    if (photos.length > 0) {
      const expiresAt = new Date(Date.now() + DOWNLOAD_LINK_TTL_MS);
      const groups = packArchiveParts(photos);
      download = {
        expiresAt: expiresAt.toISOString(),
        parts: groups.map((group, i) => {
          // Prefixed, not added to the name: archiveNameFor shortens a long
          // event name, which would cut a suffix off.
          const fileName = `shareable-${archiveNameFor(event.name, 'photos', i + 1, groups.length)}`;
          return {
            part: i + 1,
            partCount: groups.length,
            itemCount: group.length,
            bytes: group.reduce((sum, p) => sum + p.bytes, 0),
            fileName: `${fileName}.zip`,
            url: buildArchiveDownloadUrl({
              resourceType: 'image',
              publicIds: group.map((p) => p.cloudinaryPublicId),
              targetPublicId: fileName,
              expiresAt,
            }),
          };
        }),
      };
    }

    return {
      eventId: event.id,
      eventName: event.name,
      photos: photos.map((p) => {
        const guest = consentStateOf(states, 'PHOTO_GUEST_PUBLIC_SHARING', p.id);
        const organiser = consentStateOf(states, 'PHOTO_ORGANISER_SELECTED', p.id);
        return {
          id: p.id,
          mediaUrl: p.mediaUrl,
          caption: p.caption,
          createdAt: p.createdAt,
          bytes: p.bytes,
          uploaderDisplayName: p.uploadedByGuest?.firstName ?? 'A guest',
          guestConsent: { givenAt: guest.givenAt, wordingVersion: guest.wordingVersion },
          organiserSelection: { givenAt: organiser.givenAt, wordingVersion: organiser.wordingVersion },
        };
      }),
      download,
    };
  },
};
