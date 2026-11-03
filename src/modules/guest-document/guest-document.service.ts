import { randomUUID } from 'crypto';
import { type GuestDocument, type Prisma, type RsvpFieldType } from '@prisma/client';
import { guestDocumentRepository } from './guest-document.repository.js';
import {
  DOCUMENT_CONTENT_TYPES,
  cleanFileName,
  detectDocumentFormat,
  safeDownloadName,
} from './guest-document-content.util.js';
import {
  DOCUMENT_ERROR_CODES,
  DOCUMENT_FIELDS_UNAVAILABLE_MESSAGE,
  type GuestDocumentView,
  type OrganiserDocumentInfo,
  type UploadedFile,
} from './guest-document.types.js';
import { eventRepository } from '../event/event.repository.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { assertEventAcceptsRsvp, assertEventNotArchived, assertRsvpDeadlineNotPassed } from '../rsvp/rsvp-guards.util.js';
import { RSVP_ANSWER_ERROR_CODES, type RsvpAnswer } from '../rsvp/rsvp-answers.util.js';
import { assertRegistrationOpen, resolveRegistrationState } from '../event-public/registration-rules.util.js';
import { guestDocumentFolder, isGuestDocumentPublicIdInFolder } from '../upload/upload-folders.js';
import { GUEST_DOCUMENT_MAX_BYTES } from '../upload/upload-constants.js';
import { uploadPrivateRawAsset } from '../../shared/cloudinary/cloudinary-private-asset.util.js';
import { CLOUDINARY_DELETE_BATCH_LIMIT, destroyAssets } from '../../shared/cloudinary/cloudinary.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

// ─────────────────────────────────────────
//  GUEST DOCUMENTS
//
//  A DOCUMENT question's answer is a file: a proof of payment, which can
//  hold bank details. So:
//
//  - THROUGH THIS SERVER, never signed for the browser: the bytes are
//    checked for what the file really is (guest-document-content.util.ts),
//    capped at GUEST_DOCUMENT_MAX_BYTES, then stored in Cloudinary as a
//    PRIVATE raw asset in the event's documents folder. No URL serves it;
//    an organiser reads it through a 5-minute signed link
//    (guest-document-organiser.service.ts).
//  - AN UPLOAD IS A HANDLE, THEN AN ANSWER. Uploading returns the
//    document's id; the RSVP submit or the registration names it as the
//    answer (RsvpResponse.value), checked to be this event's, this
//    question's and this guest's (or, at registration, an unclaimed
//    registration upload), and attached. Never attached within 24 hours:
//    deleted by the sweep.
//  - FILES ARE DELETED, ROWS KEPT. Replaced (another upload for the same
//    question, or an RSVP naming another file), its guest removed, its
//    event deleted, the archived event's media purge, or never attached:
//    the file goes from Cloudinary and the row records when
//    (deleteRequestedAt, then deletedAt). A deletion Cloudinary refused is
//    retried by the sweep.
//  - NAMES AND CONTENTS ARE NEVER LOGGED. A file name can carry a person's
//    name; log lines carry ids and counts only, and no error message here
//    names the file (Sentry: sentry-scrub.ts masks file names and document
//    paths too).
//  - BEHIND documentFields. Off: uploads refuse with
//    DOCUMENT_FIELDS_UNAVAILABLE and guests never see a DOCUMENT question
//    (isDocumentFieldVisible); everything already received stays, and is
//    still deleted by every rule above.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
export const ORPHAN_DOCUMENT_AFTER_MS = DAY_MS;
export const GUEST_DOCUMENT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// After the feedback request's and the media retention's first sweeps.
export const GUEST_DOCUMENT_SWEEP_FIRST_RUN_DELAY_MS = 3 * 60 * 1000;

const INVALID_INVITE_MESSAGE = "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.";
const INVALID_REGISTRATION_LINK_MESSAGE = "This registration link isn't valid. Check the link, or ask the organiser for a new one.";
const UNKNOWN_QUESTION_MESSAGE = "This question isn't part of this event. Please refresh the page and try again.";
const UPLOAD_FAILED_MESSAGE = "We couldn't save your file just now. Please try again in a moment.";
export const DOCUMENT_TOO_LARGE_MESSAGE = `This file is larger than ${GUEST_DOCUMENT_MAX_BYTES / (1024 * 1024)} MB. Choose a smaller file.`;

const NO_SEATS = { primaryGuests: 0, registeredSeats: 0, totalGuests: 0 };

// ── The flag ──────────────────────────────

export const assertDocumentFieldsEnabled = (): void => {
  if (!isFeatureEnabled('documentFields')) {
    throw new HttpError(422, DOCUMENT_FIELDS_UNAVAILABLE_MESSAGE, DOCUMENT_ERROR_CODES.FIELDS_UNAVAILABLE);
  }
};

// Whether a guest sees this question at all: every type, and DOCUMENT
// only while documentFields is on. Used by every guest-facing list of
// questions and every check of a guest's answers.
export const isDocumentFieldVisible = (field: { fieldType: RsvpFieldType }): boolean =>
  field.fieldType !== 'DOCUMENT' || isFeatureEnabled('documentFields');

export const documentTooLarge = (): HttpError =>
  new HttpError(413, DOCUMENT_TOO_LARGE_MESSAGE, DOCUMENT_ERROR_CODES.TOO_LARGE);

// ── Views ─────────────────────────────────

export const toGuestDocumentView = (doc: GuestDocument): GuestDocumentView => ({
  id: doc.id,
  rsvpFieldId: doc.rsvpFieldId,
  fileName: doc.fileName,
  contentType: doc.contentType,
  sizeBytes: doc.sizeBytes,
  uploadedAt: doc.uploadedAt,
});

const toOrganiserInfo = (doc: GuestDocument): OrganiserDocumentInfo => ({
  id: doc.id,
  fileName: doc.fileName,
  contentType: doc.contentType,
  sizeBytes: doc.sizeBytes,
  uploadedAt: doc.uploadedAt,
});

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

// The DOCUMENT question an upload is for: one of the event's live ones.
const documentFieldFor = (fields: { id: string; fieldType: RsvpFieldType }[], rsvpFieldId: unknown) => {
  const field = typeof rsvpFieldId === 'string' ? fields.find((f) => f.id === rsvpFieldId && f.fieldType === 'DOCUMENT') : undefined;
  if (!field) throw new HttpError(400, UNKNOWN_QUESTION_MESSAGE, RSVP_ANSWER_ERROR_CODES.UNKNOWN_FIELD);
  return field;
};

// Checks the bytes, stores the file privately, records the row. A row that
// can't be written takes its file with it.
const storeUpload = async (
  event: { id: string; tenantId: string },
  rsvpFieldId: string,
  file: UploadedFile,
  owner: { source: 'INVITE'; inviteId: string } | { source: 'REGISTRATION' }
): Promise<GuestDocument> => {
  if (file.buffer.length > GUEST_DOCUMENT_MAX_BYTES) throw documentTooLarge();
  const format = await detectDocumentFormat(file.buffer, file.originalname);
  const fileName = cleanFileName(file.originalname, format);
  const contentType = DOCUMENT_CONTENT_TYPES[format];
  const publicId = `${guestDocumentFolder(event.tenantId, event.id)}/${randomUUID()}/${safeDownloadName(fileName, format)}`;

  const stored = await uploadPrivateRawAsset(publicId, file.buffer, contentType);
  if (!stored.ok) {
    // Cloudinary's reason can quote the public id, which carries the name:
    // only the event goes in the log.
    console.error(`[guest documents] upload for event ${event.id} failed`);
    throw new HttpError(503, UPLOAD_FAILED_MESSAGE);
  }

  try {
    return await guestDocumentRepository.create({
      id: randomUUID(),
      eventId: event.id,
      rsvpFieldId,
      inviteId: owner.source === 'INVITE' ? owner.inviteId : null,
      source: owner.source,
      cloudinaryPublicId: publicId,
      fileName,
      contentType,
      sizeBytes: file.buffer.length,
    });
  } catch (err) {
    await destroyAssets([publicId], 'raw', 'private');
    throw err;
  }
};

export interface PendingDeletionOutcome {
  deleted: number;
  failed: number;
  lastError: string | null;
}

export const guestDocumentService = {

  // ── Uploading ───────────────────────────

  // POST /api/rsvp/documents (multipart: token, rsvpFieldId, file). The
  // same gates as RSVP submit, in its order: a link that isn't valid (or
  // whose guest was removed), an archived event, an expired link, an event
  // not accepting replies, the deadline. Replacing: this guest's earlier
  // unattached upload for the same question is deleted. The upload they
  // already submitted is replaced only when they submit the new one.
  uploadForInvite: async (token: unknown, rsvpFieldId: unknown, file: UploadedFile | undefined): Promise<GuestDocumentView> => {
    assertDocumentFieldsEnabled();
    if (typeof token !== 'string' || !token) throw new HttpError(400, INVALID_INVITE_MESSAGE);
    if (!file) throw new HttpError(400, 'Choose a file to upload.');

    const invite = await guestDocumentRepository.findInviteForUpload(token);
    if (!invite || invite.isArchived || invite.guest.isArchived) throw new HttpError(404, INVALID_INVITE_MESSAGE);
    assertEventNotArchived(invite.event);
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      throw new HttpError(410, `This invitation link expired on ${formatGuestDate(invite.expiresAt)}. Contact the organiser for a new one.`);
    }
    assertEventAcceptsRsvp(resolveEffectiveStatus(invite.event));
    assertRsvpDeadlineNotPassed(invite.event.rsvpDeadline, invite.used);
    const field = documentFieldFor(invite.event.rsvpFields, rsvpFieldId);

    const doc = await storeUpload(invite.event, field.id, file, { source: 'INVITE', inviteId: invite.id });

    const replaced = await guestDocumentRepository.requestDeletion(
      { inviteId: invite.id, rsvpFieldId: field.id, attachedAt: null, id: { not: doc.id } },
      new Date()
    );
    if (replaced > 0) await guestDocumentService.deletePendingQuietly({ inviteId: invite.id });
    return toGuestDocumentView(doc);
  },

  // POST /api/public-events/:shareToken/documents (multipart: rsvpFieldId,
  // file). Only while registration is open (cancelled, finished, a draft,
  // past its closing date or deadline, no open day: registration's own
  // refusal and code). Not refused for being full: the registration says
  // that. Nobody has a credential yet, so nothing is replaced here; an
  // upload the registration never names is deleted by the sweep.
  uploadForRegistration: async (shareToken: string, rsvpFieldId: unknown, file: UploadedFile | undefined): Promise<GuestDocumentView> => {
    assertDocumentFieldsEnabled();
    if (!file) throw new HttpError(400, 'Choose a file to upload.');

    const event = await eventRepository.findByShareToken(shareToken);
    if (!event || event.visibility !== 'PUBLIC') throw new HttpError(404, INVALID_REGISTRATION_LINK_MESSAGE);
    assertRegistrationOpen(resolveRegistrationState({
      status: resolveEffectiveStatus(event),
      rsvpDeadline: event.rsvpDeadline,
      registrationClosesAt: event.registrationClosesAt,
      registrationCap: event.registrationCap,
      eventDays: event.eventDays,
    }, NO_SEATS, null));
    const field = documentFieldFor(event.rsvpFields, rsvpFieldId);

    return toGuestDocumentView(await storeUpload(event, field.id, file, { source: 'REGISTRATION' }));
  },

  // ── Answers ─────────────────────────────

  // The DOCUMENT answers among `answers` (blank ones are no answer), each
  // checked to name a live upload for that question on this event that
  // belongs to this guest: their invite's (owner.inviteId) or, at
  // registration (owner.inviteId null), an unclaimed registration upload.
  // Anything else is one refusal, whatever the cause, so the answer never
  // tells whether another guest's or another event's document exists.
  // Returns the ids named, and those still to attach.
  checkReferences: async (
    db: Prisma.TransactionClient | undefined,
    eventId: string,
    fields: { id: string; label: string; fieldType: RsvpFieldType }[],
    answers: RsvpAnswer[],
    owner: { inviteId: string | null }
  ): Promise<{ referenced: string[]; toAttach: string[] }> => {
    const documentFields = new Map(fields.filter((f) => f.fieldType === 'DOCUMENT').map((f) => [f.id, f]));
    const documentAnswers = answers.filter((a) => documentFields.has(a.rsvpFieldId) && a.value.trim().length > 0);
    if (documentAnswers.length === 0) return { referenced: [], toAttach: [] };

    const docs = new Map(
      (await guestDocumentRepository.findByIds(documentAnswers.map((a) => a.value), db)).map((d) => [d.id, d])
    );
    const toAttach: string[] = [];
    for (const answer of documentAnswers) {
      const doc = docs.get(answer.value);
      const belongs =
        !!doc &&
        doc.eventId === eventId &&
        doc.rsvpFieldId === answer.rsvpFieldId &&
        doc.deletedAt === null &&
        doc.deleteRequestedAt === null &&
        (owner.inviteId !== null
          ? doc.inviteId === owner.inviteId
          : doc.source === 'REGISTRATION' && doc.inviteId === null && doc.attachedAt === null);
      if (!belongs) {
        throw new HttpError(
          422,
          `The file for '${documentFields.get(answer.rsvpFieldId)!.label}' couldn't be found. Please upload it again.`,
          DOCUMENT_ERROR_CODES.REFERENCE_INVALID
        );
      }
      if (doc.attachedAt === null) toAttach.push(doc.id);
    }
    return { referenced: documentAnswers.map((a) => a.value), toAttach };
  },

  // Attaches inside the answer's own transaction. Fewer attached than
  // asked: the sweep took one first, or a racing registration did; the
  // whole answer is refused (and rolled back) so the guest uploads again.
  attach: async (tx: Prisma.TransactionClient, ids: string[], inviteId: string, now: Date): Promise<void> => {
    const attached = await guestDocumentRepository.attach(ids, inviteId, now, tx);
    if (attached !== ids.length) {
      throw new HttpError(422, "One of your files couldn't be found. Please upload it again.", DOCUMENT_ERROR_CODES.REFERENCE_INVALID);
    }
  },

  // Inside RSVP submit's transaction: every file this invite had attached
  // that the new answer no longer names is marked for deletion (a replaced
  // or removed file). Deleted after the commit (deletePendingQuietly).
  requestReplacedDeletion: (tx: Prisma.TransactionClient, inviteId: string, keepIds: string[], now: Date) =>
    guestDocumentRepository.requestDeletion({ inviteId, attachedAt: { not: null }, id: { notIn: keepIds } }, now, tx),

  // ── Reading ─────────────────────────────

  // The guest page's own files (/rsvp/validate), for the form to show what
  // they uploaded. Empty while documentFields is off.
  liveDocumentsForInvite: async (inviteId: string): Promise<GuestDocumentView[]> =>
    isFeatureEnabled('documentFields')
      ? (await guestDocumentRepository.findLiveAttachedForInvite(inviteId)).map(toGuestDocumentView)
      : [],

  // The guest page's answers: a DOCUMENT answer whose file was deleted
  // since (its guest removed and restored, say) is left out, so the form
  // asks for it again instead of re-sending a dead reference.
  liveAnswersOnly: async <T extends { rsvpFieldId: string; value: string }>(
    answers: T[],
    fields: { id: string; fieldType: RsvpFieldType }[]
  ): Promise<T[]> => {
    const documentFieldIds = new Set(fields.filter((f) => f.fieldType === 'DOCUMENT').map((f) => f.id));
    const documentValues = answers.filter((a) => documentFieldIds.has(a.rsvpFieldId)).map((a) => a.value);
    const live = new Set((await guestDocumentRepository.findLiveAttachedByIds(documentValues)).map((d) => d.id));
    return answers.filter((a) => !documentFieldIds.has(a.rsvpFieldId) || live.has(a.value));
  },

  // The organiser's guest details: each answer gets `document`, the file's
  // details when it is a DOCUMENT answer whose file is still kept (the
  // same invite's and question's), else null. A DOCUMENT question with no
  // answer, or `document: null`, means nothing was received.
  withDocumentInfo: async <T extends { inviteId: string; rsvpFieldId: string; value: string; rsvpField: { fieldType: RsvpFieldType } }>(
    responses: T[]
  ): Promise<(T & { document: OrganiserDocumentInfo | null })[]> => {
    const ids = responses.filter((r) => r.rsvpField.fieldType === 'DOCUMENT').map((r) => r.value);
    const docs = new Map((await guestDocumentRepository.findLiveAttachedByIds(ids)).map((d) => [d.id, d]));
    return responses.map((r) => {
      const doc = r.rsvpField.fieldType === 'DOCUMENT' ? docs.get(r.value) : undefined;
      const ours = doc && doc.inviteId === r.inviteId && doc.rsvpFieldId === r.rsvpFieldId;
      return { ...r, document: ours ? toOrganiserInfo(doc) : null };
    });
  },

  // ── Deleting ────────────────────────────

  // Deletes from Cloudinary every file marked for deletion matching
  // `where`, in batches, recording each one done; whatever Cloudinary
  // refused stays marked, for the sweep. A public id outside its event's
  // documents folder (never written by this server) is never sent, since
  // it could name another event's asset: its row is closed all the same.
  processPendingDeletions: async (where: Prisma.GuestDocumentWhereInput = {}, now: Date = new Date()): Promise<PendingDeletionOutcome> => {
    const pending = await guestDocumentRepository.findPendingDeletion(where);
    const inside = pending.filter((d) => isGuestDocumentPublicIdInFolder(d.cloudinaryPublicId, guestDocumentFolder(d.event.tenantId, d.eventId)));
    const outside = pending.filter((d) => !inside.includes(d));
    if (outside.length > 0) {
      console.warn(`[guest documents] ${outside.length} document(s) outside their folder closed, not sent to Cloudinary`);
      await guestDocumentRepository.markDeleted(outside.map((d) => d.id), now);
    }

    let deleted = outside.length;
    let failed = 0;
    let lastError: string | null = null;
    for (const batch of chunk(inside, CLOUDINARY_DELETE_BATCH_LIMIT)) {
      const result = await destroyAssets(batch.map((d) => d.cloudinaryPublicId), 'raw', 'private');
      if (!result.ok) {
        failed += batch.length;
        lastError = result.reason;
        await guestDocumentRepository.recordDeleteFailure(batch.map((d) => d.id), result.reason);
        continue;
      }
      const gone = new Set(result.deleted);
      const done = batch.filter((d) => gone.has(d.cloudinaryPublicId));
      const refused = batch.filter((d) => !gone.has(d.cloudinaryPublicId));
      deleted += (await guestDocumentRepository.markDeleted(done.map((d) => d.id), now)).count;
      if (refused.length > 0) {
        failed += refused.length;
        lastError = result.failed[0]?.reason ?? 'missing from the response';
        await guestDocumentRepository.recordDeleteFailure(refused.map((d) => d.id), lastError);
      }
    }
    return { deleted, failed, lastError };
  },

  // After a request has already succeeded (a guest removed, an event
  // deleted, an RSVP replacing a file): the deletion is the sweep's to
  // retry, never a reason to fail what the person did. Counts only in
  // the log and in Sentry.
  deletePendingQuietly: async (where: Prisma.GuestDocumentWhereInput): Promise<void> => {
    try {
      const outcome = await guestDocumentService.processPendingDeletions(where);
      if (outcome.failed > 0) {
        reportError(new Error(`[guest documents] ${outcome.failed} document(s) could not be deleted from Cloudinary, retried by the sweep`));
      }
    } catch (err) {
      console.error('[guest documents] deleting documents failed, retried by the sweep');
      reportError(err);
    }
  },

  // A guest removed (guestService.archive): every file of every invite of
  // theirs. Restoring the guest doesn't bring them back.
  deleteForGuest: async (guestId: string): Promise<void> => {
    await guestDocumentRepository.requestDeletion({ invite: { guestId } }, new Date());
    await guestDocumentService.deletePendingQuietly({ invite: { guestId } });
  },

  // An event deleted (eventService.archive): every file of the event, at
  // once, not 30 days later: these are bank details, not photos to
  // download. Restoring the event doesn't bring them back.
  deleteForEvent: async (eventId: string): Promise<void> => {
    await guestDocumentRepository.requestDeletion({ eventId }, new Date());
    await guestDocumentService.deletePendingQuietly({ eventId });
  },

  // The archived event's media purge (media-retention.service.ts): every
  // file uploaded before it began. Archiving already deleted them, so this
  // is the backstop for any still left. Throws on a database failure, as
  // the purge's own steps do.
  purgeForEvent: async (eventId: string, startedAt: Date, now: Date): Promise<PendingDeletionOutcome> => {
    await guestDocumentRepository.requestDeletion({ eventId, uploadedAt: { lte: startedAt } }, now);
    return guestDocumentService.processPendingDeletions({ eventId }, now);
  },

  // One pass: uploads never attached within 24 hours marked for deletion,
  // then every file marked and not yet deleted (these, and earlier
  // failures) deleted. Not behind the flag: deleting is never switched off.
  sweep: async (now: Date = new Date()): Promise<{ orphaned: number } & PendingDeletionOutcome> => {
    const orphaned = await guestDocumentRepository.requestDeletion(
      { attachedAt: null, uploadedAt: { lt: new Date(now.getTime() - ORPHAN_DOCUMENT_AFTER_MS) } },
      now
    );
    const outcome = await guestDocumentService.processPendingDeletions({}, now);
    if (outcome.failed > 0) {
      reportError(new Error(`[guest documents] ${outcome.failed} document(s) could not be deleted from Cloudinary, retried next sweep`));
    }
    return { orphaned, ...outcome };
  },
};

// Starts the periodic sweep, like the media retention one: shortly after
// startup, then every GUEST_DOCUMENT_SWEEP_INTERVAL_MS, never overlapping
// itself, never keeping the process alive. Started by server.ts only, so
// tests start no timer. Returns a stop function.
export const startGuestDocumentSweeps = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await guestDocumentService.sweep();
    } catch (err) {
      console.error('[guest documents] sweep failed');
      reportError(err);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void run(), GUEST_DOCUMENT_SWEEP_FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), GUEST_DOCUMENT_SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
