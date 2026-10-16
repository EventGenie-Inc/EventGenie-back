import crypto from 'crypto';
import { type ConsentKind, type EventStatus, type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { consentService, consentStateOf } from '../consent/consent.service.js';
import { currentConsentWording, type ConsentWording } from '../consent/consent-wording.js';
import { EVENT_CONSENT_KINDS, type ConsentState, type EventConsentKind, type NewConsentRecord } from '../consent/consent.types.js';
import { feedbackRepository } from './feedback.repository.js';
import { isPhotoEligible, selectedPhotoIdsOf } from './feedback-photos.util.js';
import { FEEDBACK_ERROR_CODES, parseSaveFeedbackBody, scoreRequired } from './feedback-validation.util.js';
import { type FeedbackLogoInput, type SaveFeedbackBody } from './feedback.types.js';
import { feedbackLogoFolder, isCloudinaryDeliveryUrlFor, isSignedPublicIdInFolder } from '../upload/upload-folders.js';
import { FEEDBACK_LOGO_ALLOWED_FORMATS, FEEDBACK_LOGO_MAX_BYTES } from '../upload/upload-constants.js';
import { type UploadSignatureResponse } from '../upload/upload.types.js';
import { destroyAsset, requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { signCloudinaryParams } from '../../shared/cloudinary/cloudinary-signature.util.js';

// ─────────────────────────────────────────
//  ORGANISER FEEDBACK — /api/events/:eventId/feedback (the `feedback` flag)
//
//  One feedback per event, from its organisers: tenant-scoped and under the
//  assignment lock through eventService.getScoped, like every event
//  sub-resource. Given once the event is COMPLETED (the effective status),
//  and editable afterwards. Every permission is a ConsentRecord: a tick
//  given is a grant, a tick taken away a withdrawal, and only a change is
//  recorded.
//
//  A SUPER_ADMIN can read it but not give it: a permission is the
//  company's to give, and a record naming a platform user would say
//  otherwise.
// ─────────────────────────────────────────

const ORGANISER_CONSENT_KINDS: ConsentKind[] = [...EVENT_CONSENT_KINDS, 'PHOTO_ORGANISER_SELECTED'];

const LOGO_URL_EXTENSIONS = [...FEEDBACK_LOGO_ALLOWED_FORMATS.split(','), 'jpeg'];

const assertEventCompleted = (status: EventStatus): void => {
  if (status === 'COMPLETED') return;
  throw new HttpError(
    422,
    status === 'CANCELLED'
      ? "This event was cancelled, so there's no feedback to give."
      : "You can share feedback once the event has taken place.",
    FEEDBACK_ERROR_CODES.EVENT_NOT_COMPLETED
  );
};

const assertOrganiser = (requestingRole: PlatformRole): void => {
  if (requestingRole === 'SUPER_ADMIN') {
    throw new HttpError(403, "Only the event's organisers can give feedback and permissions.");
  }
};

// The logo must be one this server signed for this tenant's logo folder,
// and its URL our delivery URL for exactly that id (STEERING "Client-
// supplied Cloudinary assets"); both are checked before anything could
// destroy it. Then its size, which only the upload response knows: too
// large, it is destroyed, like an oversized cover. The logo already stored,
// sent back unchanged, is not checked again.
const assertLogoAcceptable = (tenantId: string, logo: FeedbackLogoInput, storedPublicId: string | null): void => {
  if (logo.publicId === storedPublicId) return;
  if (!isSignedPublicIdInFolder(logo.publicId, feedbackLogoFolder(tenantId))) {
    throw new HttpError(422, "This logo wasn't uploaded for your company. Upload it again from the feedback form.", FEEDBACK_ERROR_CODES.LOGO_INVALID);
  }
  if (!isCloudinaryDeliveryUrlFor(logo.url, {
    cloudName: requireCloudinaryConfig().cloudName,
    resourceType: 'image',
    publicId: logo.publicId,
    extensions: LOGO_URL_EXTENSIONS,
  })) {
    throw new HttpError(422, "This logo's link must be the one our uploader returned for it. Upload it again.", FEEDBACK_ERROR_CODES.LOGO_INVALID);
  }
  if (logo.bytes === undefined) {
    throw new HttpError(400, 'logo.bytes is required for a new logo');
  }
  if (logo.bytes > FEEDBACK_LOGO_MAX_BYTES) {
    void destroyAsset(logo.publicId).then((result) => {
      if (!result.ok) console.error('[cloudinary cleanup] failed to delete oversized feedback logo:', result.reason);
    });
    throw new HttpError(
      422,
      `This logo is too large (${(logo.bytes / (1024 * 1024)).toFixed(1)}MB). Logos must be ${FEEDBACK_LOGO_MAX_BYTES / (1024 * 1024)}MB or smaller.`,
      FEEDBACK_ERROR_CODES.LOGO_TOO_LARGE
    );
  }
};

const toPermissionView = (state: ConsentState) => ({
  status: state.status,
  granted: state.granted,
  givenAt: state.givenAt,
  wordingVersion: state.wordingVersion,
  withdrawnAt: state.withdrawnAt,
});

// GET's body (and PUT's): the feedback (null until given), each
// permission's current state, the photos the organiser may select, which
// of them are selected, and the exact wording of every tick on the form.
// For an event already gated by eventService.getScoped.
const organiserView = async (event: { id: string; tenantId: string; status: EventStatus }) => {
  const [feedback, states, photos] = await Promise.all([
    feedbackRepository.findByEventId(event.id),
    consentService.statesForEvent(event.id),
    feedbackRepository.findApprovedGuestPhotos([event.id]),
  ]);
  const ctx = { tenantId: event.tenantId, eventId: event.id, states };
  const selected = new Set(selectedPhotoIdsOf(states));

  return {
    eventId: event.id,
    eventStatus: event.status,
    // Whether the form can be saved now: once the event has taken place.
    available: event.status === 'COMPLETED',
    feedback: feedback && {
      score: feedback.score,
      workedBest: feedback.workedBest,
      toImprove: feedback.toImprove,
      logoUrl: feedback.logoUrl,
      submittedAt: feedback.submittedAt,
      updatedAt: feedback.updatedAt,
    },
    permissions: Object.fromEntries(
      EVENT_CONSENT_KINDS.map((kind) => [kind, toPermissionView(consentStateOf(states, kind))])
    ) as Record<EventConsentKind, ReturnType<typeof toPermissionView>>,
    selectedPhotoIds: [...selected],
    eligiblePhotos: photos
      .filter((photo) => isPhotoEligible(photo, ctx))
      .map((photo) => ({
        id: photo.id,
        mediaUrl: photo.mediaUrl,
        caption: photo.caption,
        createdAt: photo.createdAt,
        uploaderDisplayName: photo.uploadedByGuest?.firstName ?? 'A guest',
        selected: selected.has(photo.id),
      })),
    wording: Object.fromEntries(ORGANISER_CONSENT_KINDS.map((kind) => [kind, currentConsentWording(kind)])) as Record<
      EventConsentKind | 'PHOTO_ORGANISER_SELECTED',
      ConsentWording
    >,
    limits: { logoMaxBytes: FEEDBACK_LOGO_MAX_BYTES, logoAllowedFormats: FEEDBACK_LOGO_ALLOWED_FORMATS },
  };
};

export const feedbackService = {
  getForOrganiser: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) =>
    organiserView(await eventService.getScoped(eventId, requestingRole, tenantId)),

  // PUT: create or edit the feedback and change any permission, in one
  // transaction under a row lock on the event. A photo newly selected must
  // be eligible right now, or nothing is saved (422).
  save: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: SaveFeedbackBody) => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertOrganiser(requestingRole);
    assertEventCompleted(event.status);
    const input = parseSaveFeedbackBody(body);

    await feedbackRepository.withEventFeedbackLock(event.id, async (tx) => {
      const existing = await feedbackRepository.findByEventId(event.id, tx);
      if (!existing && input.score === undefined) throw scoreRequired();
      if (input.logo) assertLogoAcceptable(event.tenantId, input.logo, existing?.logoPublicId ?? null);

      const states = await consentService.statesForEvent(event.id, tx);
      const records: NewConsentRecord[] = [];
      const organiserRecord = (kind: ConsentKind, memoryItemId: string | null, granted: boolean): NewConsentRecord => ({
        eventId: event.id,
        kind,
        memoryItemId,
        userId,
        guestId: null,
        action: granted ? 'GRANTED' : 'WITHDRAWN',
      });

      for (const kind of EVENT_CONSENT_KINDS) {
        const wanted = input.permissions[kind];
        if (wanted !== undefined && wanted !== consentStateOf(states, kind).granted) {
          records.push(organiserRecord(kind, null, wanted));
        }
      }

      if (input.selectedPhotoIds !== undefined) {
        const current = new Set(selectedPhotoIdsOf(states));
        const wanted = new Set(input.selectedPhotoIds);
        const added = [...wanted].filter((id) => !current.has(id));
        const removed = [...current].filter((id) => !wanted.has(id));

        if (added.length > 0) {
          const photos = await feedbackRepository.findApprovedGuestPhotos([event.id], tx);
          const ctx = { tenantId: event.tenantId, eventId: event.id, states };
          const eligible = new Set(photos.filter((photo) => isPhotoEligible(photo, ctx)).map((photo) => photo.id));
          if (added.some((id) => !eligible.has(id))) {
            throw new HttpError(
              422,
              "One of these photos can't be shared: its guest hasn't agreed to public sharing, or it's no longer in the approved album. Choose from the photos shown.",
              FEEDBACK_ERROR_CODES.PHOTO_NOT_ELIGIBLE
            );
          }
        }
        for (const id of added) records.push(organiserRecord('PHOTO_ORGANISER_SELECTED', id, true));
        for (const id of removed) records.push(organiserRecord('PHOTO_ORGANISER_SELECTED', id, false));
      }

      const logoFields = input.logo === undefined
        ? {}
        : { logoUrl: input.logo?.url ?? null, logoPublicId: input.logo?.publicId ?? null };

      if (existing) {
        await feedbackRepository.update(existing.id, userId, {
          ...(input.score !== undefined && { score: input.score }),
          ...(input.workedBest !== undefined && { workedBest: input.workedBest }),
          ...(input.toImprove !== undefined && { toImprove: input.toImprove }),
          ...logoFields,
        }, tx);
      } else {
        await feedbackRepository.create({
          eventId: event.id,
          tenantId: event.tenantId,
          score: input.score as number,
          workedBest: input.workedBest ?? null,
          toImprove: input.toImprove ?? null,
          logoUrl: input.logo?.url ?? null,
          logoPublicId: input.logo?.publicId ?? null,
          userId,
        }, tx);
      }

      await consentService.record(records, tx);
    });

    return organiserView(event);
  },

  // A signed, direct-to-Cloudinary upload for the company's logo, into the
  // tenant's own folder with a server-chosen public_id (the signature is
  // the constraint, see cloudinary-signature.util.ts). Size can't be
  // signed; it is checked on save from the reported bytes.
  requestLogoSignature: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<UploadSignatureResponse> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertOrganiser(requestingRole);
    assertEventCompleted(event.status);

    const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    // event.tenantId: identical to the caller's, since getScoped refused any
    // other tenant's event.
    const folder = feedbackLogoFolder(event.tenantId);
    const publicId = crypto.randomUUID();
    const signature = signCloudinaryParams(
      { allowed_formats: FEEDBACK_LOGO_ALLOWED_FORMATS, folder, public_id: publicId, timestamp },
      apiSecret
    );

    return {
      signature,
      timestamp,
      apiKey,
      cloudName,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      folder,
      publicId,
      allowedFormats: FEEDBACK_LOGO_ALLOWED_FORMATS,
      maxFileSizeBytes: FEEDBACK_LOGO_MAX_BYTES,
    };
  },
};
