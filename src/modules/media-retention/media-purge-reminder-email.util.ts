import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';

// ─────────────────────────────────────────
//  "PHOTOS FROM <EVENT> WILL BE DELETED ON <DATE>" — the archived-media
//  reminder (media-retention.service.ts)
//
//  An account email to an organiser, so it reads like the feedback request
//  (feedback-request-email.util.ts): calm, one job, no seal. The event name
//  is organiser-typed: plain text into the layout (which escapes it) and, in
//  the subject, sanitised as header text. The date is UTC, like every date
//  the server writes (guest-date.util.ts).
//
//  From:   "e-velope" <RESEND_EVENT_EMAIL>, as the feedback request
//  Button: "Download your photos" → <FRONTEND_BASE_URL>/events/<id>/manage/memories
// ─────────────────────────────────────────

export const memoriesTabLink = (eventId: string): string => frontendUrl(`/events/${encodeURIComponent(eventId)}/manage/memories`);

export const buildMediaPurgeReminderEmail = (input: { to: string; eventId: string; eventName: string; purgeAt: Date }): OutgoingEmail => {
  const date = formatGuestDate(input.purgeAt);
  const subject = `Photos from ${sanitizeDisplayName(input.eventName, 80) || 'your event'} will be deleted on ${date}`;

  const { html, text } = renderEmail({
    subject,
    preheader: `Download them before ${date} if you'd like to keep them.`,
    blocks: [
      { kind: 'title', text: `Photos from ${input.eventName} will be deleted on ${date}` },
      {
        kind: 'paragraph',
        text: `${input.eventName} is archived, so its Memory Hub photos and videos will be permanently deleted on ${date}.`,
      },
      {
        kind: 'paragraph',
        text: "Download them before then if you'd like to keep them. The event itself, its cover photo and its invitation design are kept.",
      },
      { kind: 'button', label: 'Download your photos', href: memoriesTabLink(input.eventId) },
    ],
    reason: `You received this because you organised ${input.eventName} on e-velope.`,
  });

  return { to: input.to, from: formatFromHeader('e-velope', eventSenderAddress()), subject, html, text };
};
