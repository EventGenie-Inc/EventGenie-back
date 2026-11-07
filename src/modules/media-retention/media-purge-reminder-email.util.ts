import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';

// ─────────────────────────────────────────
//  "PHOTOS FROM <EVENT> WILL BE DELETED ON <DATE>" — the archived-media
//  reminder (media-retention.service.ts)
//
//  It names what will go: the photos (and videos), the documents the guests
//  uploaded, or both ("Photos and documents from ..."). Documents are never
//  counted or named in it: a file name can carry a guest's details. The
//  event's cover image and uploaded invitation design go on the same date
//  (since 2026-11; before, they went when it was archived), so it says so
//  when it has them; the event itself is kept.
//
//  An account email to an organiser, so it reads like the feedback request
//  (feedback-request-email.util.ts): calm, one job, no seal. The event name
//  is organiser-typed: plain text into the layout (which escapes it) and, in
//  the subject, sanitised as header text. The date is UTC, like every date
//  the server writes (guest-date.util.ts).
//
//  From:   "e-velope" <RESEND_EVENT_EMAIL>, as the feedback request
//  Button: "Download your photos" (or "... photos and documents") →
//          <FRONTEND_BASE_URL>/events/<id>/manage/memories; documents only:
//          "Download your documents" → <FRONTEND_BASE_URL>/events/<id>/manage
// ─────────────────────────────────────────

export const memoriesTabLink = (eventId: string): string => frontendUrl(`/events/${encodeURIComponent(eventId)}/manage/memories`);

export const eventManageLink = (eventId: string): string => frontendUrl(`/events/${encodeURIComponent(eventId)}/manage`);

export const buildMediaPurgeReminderEmail = (input: {
  to: string;
  eventId: string;
  eventName: string;
  purgeAt: Date;
  // Defaults: the photos only, no cover or design.
  includesPhotos?: boolean;
  includesDocuments?: boolean;
  // The event still has a cover image / an uploaded invitation design.
  hasCover?: boolean;
  hasDesign?: boolean;
}): OutgoingEmail => {
  const photos = input.includesPhotos ?? true;
  const documents = input.includesDocuments ?? false;
  const looks = input.hasCover && input.hasDesign
    ? 'Its cover image and invitation design'
    : input.hasCover ? 'Its cover image' : input.hasDesign ? 'Its invitation design' : null;
  const alsoDeleted = looks ? ` ${looks} will be deleted with them.` : '';
  const date = formatGuestDate(input.purgeAt);
  const what = photos && documents ? 'Photos and documents' : documents ? 'Documents' : 'Photos';
  const subject = `${what} from ${sanitizeDisplayName(input.eventName, 80) || 'your event'} will be deleted on ${date}`;
  const deleted = photos && documents
    ? 'its Memory Hub photos and videos, and the documents its guests uploaded,'
    : documents ? 'the documents its guests uploaded' : 'its Memory Hub photos and videos';

  const { html, text } = renderEmail({
    subject,
    preheader: `Download them before ${date} if you'd like to keep them.`,
    blocks: [
      { kind: 'title', text: `${what} from ${input.eventName} will be deleted on ${date}` },
      {
        kind: 'paragraph',
        text: `${input.eventName} is archived, so ${deleted} will be permanently deleted on ${date}.`,
      },
      {
        kind: 'paragraph',
        text: `Download them before then if you'd like to keep them.${alsoDeleted} The event itself is kept.`,
      },
      photos
        ? { kind: 'button', label: documents ? 'Download your photos and documents' : 'Download your photos', href: memoriesTabLink(input.eventId) }
        : { kind: 'button', label: 'Download your documents', href: eventManageLink(input.eventId) },
    ],
    reason: `You received this because you organised ${input.eventName} on e-velope.`,
  });

  return { to: input.to, from: formatFromHeader('e-velope', eventSenderAddress()), subject, html, text };
};
