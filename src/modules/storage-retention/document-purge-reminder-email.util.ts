import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { LAUNCH_CONTACT_EMAIL } from '../subscription-tier-config/tier-refusal-wording.util.js';
import { type RemindedReason } from './storage-retention.types.js';

// ─────────────────────────────────────────
//  "GUEST DOCUMENTS FOR <EVENT> WILL BE DELETED ON <DATE>": the organisers'
//  reminder a week before a cancelled or finished event's documents go
//  (storage-retention.service.ts). Plain and short: what is deleted and
//  when, how to keep a copy, and what can be done about it. The owner will
//  rewrite the wording; the facts each line carries are the contract.
//
//  Built like the archived-media reminder (media-purge-reminder-email.util.ts):
//  an account email through the layout, the organiser-typed event name as
//  plain text (escaped by the layout; sanitised in the subject), the date
//  in UTC.
//
//  From:   "e-velope" <RESEND_EVENT_EMAIL>
//  Button: "Open the guest list" → <FRONTEND_BASE_URL>/events/<id>/manage/guests
// ─────────────────────────────────────────

export const guestsTabLink = (eventId: string): string => frontendUrl(`/events/${encodeURIComponent(eventId)}/manage/guests`);

export const buildDocumentPurgeReminderEmail = (input: {
  to: string;
  eventId: string;
  eventName: string;
  reason: RemindedReason;
  purgeAt: Date;
}): OutgoingEmail => {
  const date = formatGuestDate(input.purgeAt);
  const subject = `Guest documents for ${sanitizeDisplayName(input.eventName, 80) || 'your event'} will be deleted on ${date}`;

  const why = input.reason === 'CANCELLED'
    ? `${input.eventName} was cancelled, so the documents its guests uploaded with their replies (such as proofs of payment) will be permanently deleted on ${date}.`
    : `${input.eventName} has finished, so the documents its guests uploaded with their replies (such as proofs of payment) will be permanently deleted on ${date}.`;
  const restore = input.reason === 'CANCELLED'
    ? `If this event was cancelled by mistake, contact us at ${LAUNCH_CONTACT_EMAIL} before then.`
    : "Deleted documents can't be recovered.";

  const { html, text } = renderEmail({
    subject,
    preheader: `Download any you need before ${date}.`,
    blocks: [
      { kind: 'title', text: `Guest documents for ${input.eventName} will be deleted on ${date}` },
      { kind: 'paragraph', text: why },
      {
        kind: 'paragraph',
        text: "To keep a copy, open the event's guest list, open each guest's details and use View on their document to download it.",
      },
      { kind: 'paragraph', text: restore },
      { kind: 'button', label: 'Open the guest list', href: guestsTabLink(input.eventId) },
    ],
    reason: `You received this because you organised ${input.eventName} on e-velope.`,
  });

  return { to: input.to, from: formatFromHeader('e-velope', eventSenderAddress()), subject, html, text };
};
